#!/usr/bin/env python3
"""XD-Signature-v1 请求签名参考实现（Python 3.8+）。

依赖：`cryptography`（主流加密库；也可换成 pycryptodome，签名算法不变）。

规范串固定 11 行（每行以 \\n 连接）：
    XD-Signature-v1 / {METHOD} / {CANONICAL_PATH} / {CANONICAL_QUERY} /
    {TIMESTAMP} / {NONCE} / {APP_ID} / {KEY_ID} / {REQUEST_ID} /
    {CONTENT_TYPE} / {SHA256_HEX(rawBody)}
签名算法 RSA-SHA256（PKCS#1 v1.5），签名值 Base64。

自检：
    XD_APP_ID=... XD_KEY_ID=... XD_PRIVATE_KEY_PATH=./private_key.pem \\
    python3 xd_signature.py POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'
"""

from __future__ import annotations

import base64
import hashlib
import os
import sys
import time
import uuid
import secrets
from typing import Dict, Optional, Tuple

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

SIGNATURE_VERSION = "XD-Signature-v1"

# 与 urllib.parse.quote 的 safe 集合一致，另补 RFC3986 未保留字符
_UNRESERVED = "-._~"


def sha256_hex(raw_body: bytes) -> str:
    return hashlib.sha256(raw_body or b"").hexdigest()


def rfc3986_encode(value: str) -> str:
    """RFC3986 严格编码：不保留 !'()* ，空格编成 %20。"""
    from urllib.parse import quote

    return quote(str(value), safe=_UNRESERVED)


def _decode_once(value: str) -> str:
    from urllib.parse import unquote

    return unquote(value.replace("+", "%20"))


def canonicalize_path(raw_path: str) -> str:
    if not raw_path or not raw_path.startswith("/") or raw_path.startswith("//"):
        raise ValueError("路径必须是以 / 开头的绝对路径")
    if "\\" in raw_path or ".." in raw_path:
        raise ValueError("路径不得包含反斜杠或 ..")
    decoded = _decode_once(raw_path)
    if "\\" in decoded or ".." in decoded or "//" in decoded:
        raise ValueError("路径解码后含非法片段")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in decoded):
        raise ValueError("路径含控制字符")
    return decoded


def canonicalize_query(raw_query: str) -> str:
    """逐键值解码一次 → RFC3986 重编码 → 按键名排序（稳定排序保留重复键相对顺序）。"""
    if not raw_query:
        return ""
    pairs = []
    for pair in raw_query.split("&"):
        raw_key, _, raw_value = pair.partition("=")
        pairs.append((_decode_once(raw_key), _decode_once(raw_value)))
    # Python 的 sort 稳定：重复键保留原相对顺序
    pairs.sort(key=lambda item: rfc3986_encode(item[0]))
    return "&".join(f"{rfc3986_encode(k)}={rfc3986_encode(v)}" for k, v in pairs)


def canonicalize_content_type(raw_value: str) -> str:
    if not raw_value:
        return ""
    return raw_value.split(";", 1)[0].strip().lower()


def split_url(url: str) -> Tuple[str, str]:
    path, _, query = str(url).partition("?")
    return canonicalize_path(path), canonicalize_query(query)


def build_signing_string(
    method: str,
    path: str,
    query: str,
    timestamp: str,
    nonce: str,
    app_id: str,
    key_id: str,
    request_id: str,
    content_type: str,
    raw_body: bytes,
) -> str:
    upper_method = str(method).upper()
    if not upper_method.isalpha() or not upper_method.isupper():
        raise ValueError("HTTP 方法非法")
    return "\n".join(
        [
            SIGNATURE_VERSION,
            upper_method,
            path,
            query,
            str(timestamp),
            str(nonce),
            str(app_id),
            str(key_id),
            str(request_id),
            canonicalize_content_type(content_type),
            sha256_hex(raw_body),
        ]
    )


def load_private_key(pem_path: str):
    with open(pem_path, "rb") as handle:
        return serialization.load_pem_private_key(handle.read(), password=None)


def sign(signing_string: str, private_key) -> str:
    signature = private_key.sign(signing_string.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(signature).decode("ascii")


def build_signed_headers(
    app_id: str,
    key_id: str,
    private_key,
    method: str,
    url: str,
    content_type: str = "application/json",
    body: str = "",
    timestamp: Optional[int] = None,
    nonce: Optional[str] = None,
    request_id: Optional[str] = None,
) -> Dict[str, object]:
    path, query = split_url(url)
    timestamp = int(timestamp if timestamp is not None else time.time())
    nonce = nonce or secrets.token_hex(12)
    request_id = request_id or str(uuid.uuid4())
    signing_string = build_signing_string(
        method,
        path,
        query,
        str(timestamp),
        nonce,
        app_id,
        key_id,
        request_id,
        content_type,
        body.encode("utf-8"),
    )
    return {
        "signingString": signing_string,
        "headers": {
            "Content-Type": content_type,
            "X-XD-App-Id": str(app_id),
            "X-XD-Timestamp": str(timestamp),
            "X-XD-Nonce": nonce,
            "X-XD-Key-Id": str(key_id),
            "X-XD-Request-Id": request_id,
            "X-XD-Sign": sign(signing_string, private_key),
        },
    }


if __name__ == "__main__":
    method = sys.argv[1] if len(sys.argv) > 1 else "POST"
    url = sys.argv[2] if len(sys.argv) > 2 else "/api/open/v1/payments"
    body = sys.argv[3] if len(sys.argv) > 3 else ""
    pem_path = os.environ.get("XD_PRIVATE_KEY_PATH")
    if not pem_path:
        sys.stderr.write("请通过 XD_PRIVATE_KEY_PATH 提供 PEM 私钥（仅本地自检用）\n")
        sys.exit(1)
    result = build_signed_headers(
        os.environ.get("XD_APP_ID", "xdop_example000000000"),
        os.environ.get("XD_KEY_ID", "mkid_xxxxxxxxxxxxxxxx"),
        load_private_key(pem_path),
        method,
        url,
        os.environ.get("XD_CONTENT_TYPE", "application/json; charset=utf-8"),
        body,
        timestamp=int(os.environ["XD_TIMESTAMP"]) if os.environ.get("XD_TIMESTAMP") else None,
        nonce=os.environ.get("XD_NONCE"),
        request_id=os.environ.get("XD_REQUEST_ID"),
    )
    print(result["signingString"])
    print("---- headers ----")
    for name, value in result["headers"].items():
        print(f"{name}: {value}")

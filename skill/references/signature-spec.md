# 签名规范（三套规范串，互不复用）

> 人读版：`docs/09-security-redlines.md`（签名与红线）、`docs/05-webhook-verification.md`（事件）（**不在本 Skill 包内**：Skill 包只含 `skill/**` 与 `examples/**`，需要时从门户「文档下载」包或公开仓的 `docs/` 取）。

## 1. 请求签名 `XD-Signature-v1`（商家 → 平台）

六头：`X-XD-App-Id`、`X-XD-Timestamp`、`X-XD-Nonce`、`X-XD-Key-Id`、`X-XD-Request-Id`、`X-XD-Sign`。算法 RSA-SHA256，签名值 Base64。

待签名串（11 行，`\n` 连接）：

```text
XD-Signature-v1
{METHOD}
{CANONICAL_PATH}
{CANONICAL_QUERY}
{TIMESTAMP}
{NONCE}
{APP_ID}
{KEY_ID}
{REQUEST_ID}
{CONTENT_TYPE}
{SHA256_HEX(rawBody)}
```

| 字段 | 规则 |
| --- | --- |
| METHOD | 大写 ASCII |
| CANONICAL_PATH | 绝对路径（不含 host），URL 解码恰好一次；禁 `..`、`//`、反斜杠、控制字符 |
| CANONICAL_QUERY | 逐键值解码一次 → RFC3986 重编码 → 按键名排序（重复键保留原相对顺序）；无 query 时为空行 |
| TIMESTAMP | 秒级 epoch（强校验时间窗） |
| NONCE | 一次性；复用即判重放（`409 OPEN_API_REPLAY`） |
| CONTENT_TYPE | 小写、去 `;` 参数；**没有带这个头时该行为空行**（`GET` 且无请求体即如此）——不要写 `application/json` |
| SHA256_HEX(rawBody) | 原始请求体字节的小写十六进制；无体为空串哈希 |

## 2. 响应签名 `XD-Response-v1`（平台 → 商家）

响应头：`X-XD-Response-Sign`、`-Key-Id`、`-Timestamp`、`-Nonce`。待签名串 **8 行**：

```text
XD-Response-v1
{STATUS}
{CONTENT_TYPE}
{REQUEST_ID}
{TIMESTAMP}
{NONCE}
{KEY_ID}
{SHA256_HEX(rawBody)}
```

- `CONTENT_TYPE` 与请求侧**同一套归一化**：**小写、去 `;` 参数**（响应头通常是 `application/json; charset=utf-8`，参与签名的是 `application/json`）——这一条写错会让**每个**响应都验不过。
- `STATUS` 为十进制状态码字符串；`SHA256_HEX(rawBody)` 取**实际交付字节**。
- **不是每个响应都带这四个头**：鉴权链之前的拒绝（来源 IP 403、请求体门卫 400/413、六头形态 400、验签失败 401、nonce 重放 409）**不带**。正确做法：**四头齐备才强制验签**；缺头按未签名响应处理并保留其 `code`/`requestId`，别当篡改丢弃。
- 平台公钥只从**固定文档页/门户**获取，不从响应体里取；文档页见 `docs/02-integration-guide.md` §3.1（含 `kid`、指纹与 PEM 正文，与门户同源）。

## 3. 事件签名 `XD-Webhook-v1`（平台 → 商家回调）

投递头：`X-XD-Webhook-Signature`、`-Key-Id`、`-Timestamp`、`-Nonce`、`-Event-Id`、`-Event-Type`。待签名串 **7 行**：

```text
XD-Webhook-v1
{EVENT_ID}
{EVENT_TYPE}
{TIMESTAMP}
{NONCE}
{KEY_ID}
{SHA256_HEX(rawBody)}
```

**必须对收到的原始字节算哈希**——把已解析对象重新序列化会因字段顺序、空白、中文转义差异导致验签失败。

## 4. golden 向量自检（不依赖密钥）

固定输入：`POST /api/open/v1/payments?b=2&a=1`、`timestamp=1758888888`、`nonce=6f1c2f7a9d0b4e51`、`appId=xdop_example000000000`、`keyId=kid_example`、`requestId=018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55`、`Content-Type: application/json; charset=utf-8`、body `{"outTradeNo":"SHOP20260926A0001"}`。

期望规范串（逐字节）：

```text
XD-Signature-v1
POST
/api/open/v1/payments
a=1&b=2
1758888888
6f1c2f7a9d0b4e51
xdop_example000000000
kid_example
018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55
application/json
954802c8e1bc119a1927d07af5c27d7c29c6d9467d8e93ccf83ebca8ef0252c7
```

能对上这一串，说明 query 排序、`Content-Type` 归一化、body 哈希三处都没写错。

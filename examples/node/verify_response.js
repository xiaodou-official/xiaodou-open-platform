#!/usr/bin/env node
'use strict';

/**
 * `XD-Response-v1` 响应验签参考实现（2026-09-28 补）。
 *
 * 为什么需要它：上线检查清单 A6 把「响应验签」列为硬项，而此前**没有任何可抄
 * 的实现**——`examples/` 只覆盖请求签名与事件验签，demo 的 mock 平台也不回
 * `X-XD-Response-*` 四头，卖家在本地**永远测不到**这一条。最常见的踩坑是
 * `CONTENT_TYPE` 少做归一化（响应头通常是 `application/json; charset=utf-8`，
 * 参与签名的是 `application/json`）——写错会让**每一个**响应都验不过。
 *
 * 规范串（8 行，`\n` 连接；见 docs/09 §3）：
 *   XD-Response-v1
 *   <STATUS>
 *   <CONTENT_TYPE>
 *   <REQUEST_ID>
 *   <TIMESTAMP>
 *   <NONCE>
 *   <KEY_ID>
 *   <SHA256_HEX(rawBody)>
 *
 * 判据纪律：
 * - **四头齐备才验签**：鉴权链之前的拒绝（来源 IP 403、请求体门卫 400/413、
 *   六头形态 400、验签失败 401、nonce 重放 409）与「平台签名密钥不可用」的 503
 *   **不带**这四头——缺头按未签名响应处理并保留其 `code`/`requestId`，不要当篡改丢弃；
 * - `SHA256_HEX(rawBody)` 必须取**实际交付字节**（不是重新序列化的 JSON）；
 * - 平台公钥只从固定文档页/门户取，**不要**从未验签的响应里取。
 *
 * 用法（库）：
 *   const { verifyResponse } = require('./verify_response');
 *   const ok = verifyResponse({ status, headers, rawBody, platformPublicKeyPem });
 *
 * 用法（CLI 自检，用固定输入核对规范串——不需要密钥）：
 *   node examples/node/verify_response.js --golden
 */

const crypto = require('node:crypto');

const RESPONSE_SIGNATURE_VERSION = 'XD-Response-v1';

const RESPONSE_HEADERS = Object.freeze({
  SIGNATURE: 'x-xd-response-sign',
  KEY_ID: 'x-xd-response-key-id',
  TIMESTAMP: 'x-xd-response-timestamp',
  NONCE: 'x-xd-response-nonce',
  REQUEST_ID: 'x-xd-request-id',
});

/** 与请求侧同一套归一化：小写 + 去掉 `;` 参数。空值返回空串。 */
function canonicalizeContentType(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') return '';
  return String(rawValue).split(';', 1)[0].trim().toLowerCase();
}

function sha256Hex(body) {
  return crypto.createHash('sha256').update(body === undefined || body === null ? '' : body).digest('hex');
}

function buildResponseSigningString({ status, contentType, requestId, timestamp, nonce, keyId, rawBody }) {
  return [
    RESPONSE_SIGNATURE_VERSION,
    String(status),
    String(contentType),
    String(requestId),
    String(timestamp),
    String(nonce),
    String(keyId),
    sha256Hex(rawBody),
  ].join('\n');
}

/**
 * 响应验签。任何异常或不符一律返回 `{ ok: false, reason }`（fail-closed）。
 * 缺四头返回 `{ ok: false, reason: 'UNSIGNED' }`——**不是**失败，调用方应把它
 * 当作未签名响应（保留其 code/requestId 排障），而不是当篡改丢弃。
 */
function verifyResponse({ status, headers, rawBody, platformPublicKeyPem }) {
  try {
    const header = (name) => {
      if (typeof headers.get === 'function') {
        const raw = headers.get(name);
        return raw === undefined || raw === null ? '' : String(raw).trim();
      }
      const wanted = String(name).toLowerCase();
      for (const key of Object.keys(headers || {})) {
        if (key.toLowerCase() === wanted) {
          const raw = headers[key];
          return raw === undefined || raw === null ? '' : String(raw).trim();
        }
      }
      return '';
    };
    const signatureBase64 = header(RESPONSE_HEADERS.SIGNATURE);
    const keyId = header(RESPONSE_HEADERS.KEY_ID);
    const timestamp = header(RESPONSE_HEADERS.TIMESTAMP);
    const nonce = header(RESPONSE_HEADERS.NONCE);
    if (!signatureBase64 || !keyId || !timestamp || !nonce) {
      return { ok: false, reason: 'UNSIGNED' };
    }
    const signingString = buildResponseSigningString({
      status,
      contentType: canonicalizeContentType(header('content-type')),
      requestId: header(RESPONSE_HEADERS.REQUEST_ID),
      timestamp,
      nonce,
      keyId,
      rawBody,
    });
    const ok = crypto
      .createVerify('RSA-SHA256')
      .update(signingString, 'utf8')
      .verify(platformPublicKeyPem, signatureBase64, 'base64');
    return ok ? { ok: true, keyId } : { ok: false, reason: 'SIGNATURE_MISMATCH' };
  } catch (error) {
    return { ok: false, reason: 'ERROR' };
  }
}

// ---------------------------------------------------------------- CLI 自检

if (require.main === module) {
  if (!process.argv.includes('--golden')) {
    console.error('用法：node examples/node/verify_response.js --golden（固定输入核对规范串，不需要密钥）');
    process.exit(2);
  }
  const rawBody = '{"requestId":"018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55","status":"CREATED"}';
  const signingString = buildResponseSigningString({
    status: 200,
    contentType: canonicalizeContentType('application/json; charset=utf-8'),
    requestId: '018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55',
    timestamp: '1790426096',
    nonce: '6f1c2f7a9d0b4e51',
    keyId: 'xdpk-2026-09',
    rawBody,
  });
  console.log('== 规范串（8 行，逐字节）==');
  console.log(signingString);
  console.log('\n== 自检分项 ==');
  console.log('CONTENT_TYPE 归一化（应为 application/json）：'
    + (signingString.split('\n')[2] === 'application/json' ? 'OK' : 'FAIL'));
  console.log('body 哈希（应为实际交付字节的 SHA-256）：'
    + (signingString.split('\n')[7] === sha256Hex(rawBody) ? 'OK' : 'FAIL'));
  console.log('行数（应为 8）：', signingString.split('\n').length);
}

module.exports = {
  RESPONSE_SIGNATURE_VERSION,
  RESPONSE_HEADERS,
  canonicalizeContentType,
  buildResponseSigningString,
  verifyResponse,
};

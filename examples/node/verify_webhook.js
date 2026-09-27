#!/usr/bin/env node
'use strict';

/**
 * XD-Webhook-v1 事件验签参考实现（Node.js，零依赖）。
 *
 * 规范串固定 7 行：
 *   XD-Webhook-v1
 *   {EVENT_ID}
 *   {EVENT_TYPE}
 *   {TIMESTAMP}
 *   {NONCE}
 *   {KEY_ID}
 *   {SHA256_HEX(rawBody)}
 *
 * 六个取值一律来自投递头（X-XD-Webhook-*），**不要**从 body 里取；
 * rawBody 必须是**收到的原始字节**（未经 JSON 解析再序列化）。
 */

const crypto = require('node:crypto');

const WEBHOOK_SIGNATURE_VERSION = 'XD-Webhook-v1';

const WEBHOOK_HEADERS = Object.freeze({
  SIGNATURE: 'x-xd-webhook-signature',
  KEY_ID: 'x-xd-webhook-key-id',
  TIMESTAMP: 'x-xd-webhook-timestamp',
  NONCE: 'x-xd-webhook-nonce',
  EVENT_ID: 'x-xd-webhook-event-id',
  EVENT_TYPE: 'x-xd-webhook-event-type',
});

function sha256Hex(rawBody) {
  const body = rawBody === undefined || rawBody === null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'));
  return crypto.createHash('sha256').update(body).digest('hex');
}

function buildWebhookSigningString({ eventId, eventType, timestamp, nonce, keyId, rawBody }) {
  for (const [name, value] of Object.entries({ eventId, eventType, timestamp, nonce, keyId })) {
    if (value === undefined || value === null || String(value) === '') {
      throw new Error(`缺少事件字段: ${name}`);
    }
  }
  return [
    WEBHOOK_SIGNATURE_VERSION,
    String(eventId),
    String(eventType),
    String(timestamp),
    String(nonce),
    String(keyId),
    sha256Hex(rawBody),
  ].join('\n');
}

/**
 * 验签。任何异常或不符一律返回 false（fail-closed）。
 * @param {object} p
 * @param {object} p.headers Express/Koa 风格 headers（大小写不敏感）
 * @param {string|Buffer} p.rawBody 收到的原始请求体字节
 * @param {string} p.platformPublicKeyPem 平台公钥（来自固定文档页/门户，不从响应里取）
 */
function verifyWebhook({ headers, rawBody, platformPublicKeyPem }) {
  try {
    const header = (name) => {
      const raw = typeof headers.get === 'function' ? headers.get(name) : headers[name];
      return raw === undefined || raw === null ? '' : String(raw).trim();
    };
    const signatureBase64 = header(WEBHOOK_HEADERS.SIGNATURE);
    const signingString = buildWebhookSigningString({
      eventId: header(WEBHOOK_HEADERS.EVENT_ID),
      eventType: header(WEBHOOK_HEADERS.EVENT_TYPE),
      timestamp: header(WEBHOOK_HEADERS.TIMESTAMP),
      nonce: header(WEBHOOK_HEADERS.NONCE),
      keyId: header(WEBHOOK_HEADERS.KEY_ID),
      rawBody,
    });
    return crypto
      .createVerify('RSA-SHA256')
      .update(signingString, 'utf8')
      .verify(platformPublicKeyPem, signatureBase64, 'base64');
  } catch (error) {
    return false;
  }
}

/**
 * 幂等落账骨架：先按 eventId 去重、再提交业务、最后返回成功。
 * 这里只给形状——真实的去重存储请用唯一索引（数据库层保证）。
 * @param {object} p
 * @param {object} p.headers
 * @param {string|Buffer} p.rawBody
 * @param {string} p.platformPublicKeyPem
 * @param {object} p.store { hasEvent(eventId), markEvent(eventId, record) }
 * @param {Function} p.handler 业务处理（订单/退款状态迁移 + 交付动作）
 */
async function handleWebhookOnce({ headers, rawBody, platformPublicKeyPem, store, handler }) {
  if (!verifyWebhook({ headers, rawBody, platformPublicKeyPem })) {
    return { status: 400, body: '' }; // 验签失败：不落账、不回 success（需人工介入配置）
  }
  const payload = JSON.parse(rawBody.toString('utf8'));
  if (store.hasEvent(payload.eventId)) {
    return { status: 200, body: 'success' }; // 幂等：重复投递直接回成功
  }
  try {
    await handler(payload);
    store.markEvent(payload.eventId, { receivedAt: Date.now(), eventType: payload.eventType });
    return { status: 200, body: 'success' };
  } catch (error) {
    return { status: 500, body: '' }; // 处理失败：不标记，让平台重试
  }
}

module.exports = {
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_HEADERS,
  sha256Hex,
  buildWebhookSigningString,
  verifyWebhook,
  handleWebhookOnce,
};

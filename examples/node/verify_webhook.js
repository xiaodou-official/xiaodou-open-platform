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
      if (typeof headers.get === 'function') {
        const raw = headers.get(name);
        return raw === undefined || raw === null ? '' : String(raw).trim();
      }
      // 普通对象：按键名**大小写不敏感**查找（HTTP 头名不区分大小写；
      // 只按小写键查表会把规范大小写键的合法投递判成验签失败）。
      const wanted = String(name).toLowerCase();
      for (const key of Object.keys(headers || {})) {
        if (key.toLowerCase() === wanted) {
          const raw = headers[key];
          return raw === undefined || raw === null ? '' : String(raw).trim();
        }
      }
      return '';
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
 * 幂等落账骨架（正确形状：**去重与业务同一事务提交**）。
 *
 * 反例（两类常见写法的症状，别抄）：
 * - 去重查询/标记不 await——异步存储下 Promise 恒为真值，事件会被整体跳过；
 * - 先执行业务、后写去重标记——并发投递同一事件会执行业务两次；只加唯一索引
 *   不够，第二次的冲突发生在业务已经跑完之后。
 *
 * `store.runOnce(eventId, record, run)` 的合同（要求唯一索引 + 事务）：
 *   1) 事务内先向「已处理事件表」插入 eventId 行（eventId 建**唯一索引**）；
 *      唯一键冲突 ⇒ 回滚并返回 { state: 'duplicate' }，**不执行** run；
 *   2) 同一事务内执行 run()（业务：订单/退款状态迁移 + 交付动作）；
 *   3) 提交成功 ⇒ 返回 { state: 'processed' }；run 抛错 ⇒ 整体回滚
 *      （去重行一并回滚），错误抛给调用方——平台重试即可重新处理。
 * 一句话：**先占位、再干活、同事务、同提交**。
 *
 * 示意实现（关系库伪代码）：
 *   async runOnce(eventId, record, run) {
 *     return db.transaction(async (tx) => {
 *       if (!await tx.insertIfAbsent('processed_events', { eventId, ...record })) {
 *         return { state: 'duplicate' };
 *       }
 *       await run(tx);
 *       return { state: 'processed' };
 *     });
 *   }
 *
 * @param {object} p
 * @param {object} p.headers
 * @param {string|Buffer} p.rawBody
 * @param {string} p.platformPublicKeyPem
 * @param {object} p.store { runOnce(eventId, record, run) }（合同见上）
 * @param {Function} p.handler 业务处理（订单/退款状态迁移 + 交付动作）
 */
async function handleWebhookOnce({ headers, rawBody, platformPublicKeyPem, store, handler }) {
  if (!verifyWebhook({ headers, rawBody, platformPublicKeyPem })) {
    return { status: 400, body: '' }; // 验签失败：不落账、不回 success（需人工介入配置）
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return { status: 400, body: '' }; // 验签通过但 body 非法：丢弃，人工排查
  }
  try {
    // 去重与业务在 store.runOnce 的**同一事务**里提交：重复投递（去重行冲突）
    // 不会执行 handler；业务失败整体回滚（去重行随之回滚），让平台重试。
    await store.runOnce(
      payload.eventId,
      { receivedAt: Date.now(), eventType: payload.eventType },
      () => handler(payload),
    );
    // runOnce 返回 { state: 'duplicate' | 'processed' }——两者都回 success。
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

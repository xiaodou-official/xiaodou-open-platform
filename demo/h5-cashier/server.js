#!/usr/bin/env node
'use strict';

/**
 * 本地收银 demo（零外部依赖、零生产连接）。
 *
 * 一个进程里同时扮演三方：
 *   ① 模拟平台     /mock/open/v1/*    —— 验签、建单、查单、关单、退款、投递事件
 *   ② 商家后端     /merchant/*        —— 真正按 XD-Signature-v1 签名调用平台、消费事件、做查单补偿
 *   ③ 静态页面     /, /preview, /cashier/:token, /styles.css
 *
 * 密钥对在进程内运行时生成（不落盘、不进仓库）；平台侧登记的是本次运行的公钥。
 * 只用 loopback + 内存，不连任何生产支付机构，不发起任何资金动作。
 *
 *   node demo/h5-cashier/server.js [--port 8787]
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sign = require('../../examples/node/sign.js');
const webhook = require('../../examples/node/verify_webhook.js');

const PORT = (() => {
  const index = process.argv.indexOf('--port');
  return index === -1 ? 8787 : Number(process.argv[index + 1]);
})();

const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_ID = 'xdop_demo000000000000';
const KEY_ID = 'kid_demo_1';
const PLATFORM_KEY_ID = 'platform_kid_demo';
const NOTIFY_URL = `http://127.0.0.1:${PORT}/merchant/webhook`;
const LINKS = Object.freeze({ ALIPAY_H5: 'ALIPAY_AGGREGATION_NATIVE', WECHAT_H5: 'WECHAT_JSAPI' });

// ── 运行期密钥（仅内存） ──────────────────────────────────────────────
const merchantKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPublicKeyPem = merchantKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const merchantPrivateKeyPem = merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const platformPrivateKeyPem = platformKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const platformPublicKeyPem = platformKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// ── 内存状态 ─────────────────────────────────────────────────────────
const state = {
  orders: new Map(), // outTradeNo -> order
  refunds: new Map(), // outRefundNo -> refund
  events: [], // 平台已产生的事件（模拟平台侧账本）
  merchantEvents: [], // 商家侧已验签落账的事件
  merchantSeenEventIds: new Set(), // eventId 去重
  merchantLog: [], // 商家后端调用日志（用于页面展示）
};

function log(kind, message) {
  const entry = { at: new Date().toISOString(), kind, message };
  state.merchantLog.unshift(entry);
  state.merchantLog.length = Math.min(state.merchantLog.length, 60);
  return entry;
}

// ── 模拟平台 ─────────────────────────────────────────────────────────
function verifyMerchantRequest(req, rawBody) {
  const headers = req.headers;
  const url = req.url;
  const queryIndex = url.indexOf('?');
  const rawPath = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : url.slice(queryIndex + 1);
  let signingString;
  try {
    signingString = sign.buildSigningString({
      method: req.method,
      path: sign.canonicalizePath(rawPath),
      query: sign.canonicalizeQuery(rawQuery),
      timestamp: headers['x-xd-timestamp'],
      nonce: headers['x-xd-nonce'],
      appId: headers['x-xd-app-id'],
      keyId: headers['x-xd-key-id'],
      requestId: headers['x-xd-request-id'],
      contentType: headers['content-type'],
      rawBody,
    });
  } catch (error) {
    return { ok: false, code: 'OPEN_API_SIGNATURE_INVALID' };
  }
  if (headers['x-xd-app-id'] !== APP_ID || headers['x-xd-key-id'] !== KEY_ID) {
    return { ok: false, code: 'OPEN_API_SIGNATURE_INVALID' };
  }
  const ok = crypto
    .createVerify('RSA-SHA256')
    .update(signingString, 'utf8')
    .verify(merchantPublicKeyPem, headers['x-xd-sign'] || '', 'base64');
  return ok ? { ok: true, requestId: headers['x-xd-request-id'] } : { ok: false, code: 'OPEN_API_SIGNATURE_INVALID' };
}

function orderSnapshot(order, { includeMaterials }) {
  const activeAttempt = [...order.attempts].reverse().find((attempt) => attempt.state === 'PENDING');
  const alive = order.status === 'CREATED' || order.status === 'PAYING';
  const materialsOk = Boolean(includeMaterials && activeAttempt && alive);
  return {
    openOrderId: order.openOrderId,
    outTradeNo: order.outTradeNo,
    status: order.status,
    closedReason: order.closedReason,
    channel: order.channel,
    tradeScope: order.tradeScope,
    links: [LINKS[order.channel]],
    amountFen: order.amountFen,
    currency: 'CNY',
    attach: order.attach,
    expireAt: order.expireAt,
    payUrl: materialsOk ? `${order.materials.payUrl}` : null,
    qrCode: materialsOk && order.channel === 'ALIPAY_H5' ? order.materials.qrCode : null,
    payUrlExpireHint: materialsOk ? Math.floor(new Date(order.expireAt).getTime() / 1000) : null,
    nextAction: alive && !activeAttempt ? 'CREATE_ATTEMPT' : undefined,
    latestAttempt: activeAttempt
      ? { state: activeAttempt.state, expiresAt: order.expireAt }
      : undefined,
    feeProjection: order.feeProjection,
  };
}

function createOrder({ outTradeNo, channel, amountFen, subject, attach }) {
  if (state.orders.has(outTradeNo)) return { replayed: true, order: state.orders.get(outTradeNo) };
  const now = Date.now();
  const order = {
    openOrderId: `op_${crypto.randomBytes(13).toString('hex').toUpperCase()}`,
    outTradeNo,
    channel,
    tradeScope: 'CARD_VIRTUAL',
    amountFen,
    subject,
    attach: attach || null,
    status: 'CREATED',
    closedReason: null,
    expireAt: new Date(now + 10 * 60 * 1000).toISOString(),
    attempts: [],
    feeProjection: {
      ruleVersion: 'demo-config-v1',
      tier: 'STANDARD',
      merchantRateBps: 0,
      companyServiceFeeRateBps: 0,
      merchantSettlementFen: 0,
      companyServiceFeeFen: 0,
    },
    materials: null,
  };
  applyAttempt(order);
  state.orders.set(outTradeNo, order);
  return { replayed: false, order };
}

function applyAttempt(order) {
  const token = crypto.randomBytes(18).toString('base64url');
  order.attempts.push({ state: 'PENDING', token, createdAt: new Date().toISOString() });
  // demo 里用本地地址充当「平台收银页地址」与「官方收款码」；
  // 收款码随尝试更换（真实语义：新尝试=新码，旧码不可复用）。
  order.materials = {
    payUrl: `http://127.0.0.1:${PORT}/cashier/${token}`,
    qrCode: order.channel === 'ALIPAY_H5'
      ? `https://qr.alipay.com/bax0demo${crypto.randomBytes(9).toString('hex')}`
      : null,
  };
  if (order.status === 'CREATED') order.status = 'PAYING';
}

/**
 * 事件体与**生产同形**（`webhookEventService`）：
 * - `eventAmountFen`：只有 `PAYMENT_SUCCEEDED` 带实付金额，关闭/失败恒 `0`；退款事件带退款额；
 * - `reason`：仅 `PAYMENT_CLOSED` 且属平台封闭词表时回带，其余为空；
 * - `outRefundNo`：退款事件必带，订单事件恒 `null`；
 * - `stateVersion`：**恒 `0`**——生产当前不逐次递增，用它判乱序会把后续事件
 *   全部当成旧事件丢掉。判新旧请用订单/退款状态机。
 */
function emitEvent(order, eventType, refund = null) {
  const isRefund = Boolean(refund);
  const isOrderSucceeded = !isRefund && eventType === 'PAYMENT_SUCCEEDED';
  const event = {
    eventId: `wev_${crypto.randomBytes(12).toString('hex')}`,
    eventType,
    appId: APP_ID,
    outTradeNo: order.outTradeNo,
    outRefundNo: isRefund ? refund.outRefundNo : null,
    eventAmountFen: isRefund
      ? Number(refund.amountFen)
      : (isOrderSucceeded ? Number(order.amountFen) : 0),
    grossAmountFen: Number(order.amountFen),
    status: isRefund ? refund.state : order.status,
    reason: !isRefund && eventType === 'PAYMENT_CLOSED'
      && ['EXPIRED', 'MERCHANT_CLOSED', 'PROVIDER_CLOSED'].includes(order.closedReason)
      ? order.closedReason
      : null,
    occurredAt: Math.floor(Date.now() / 1000),
    stateVersion: 0,
    attach: order.attach,
    feeProjection: order.feeProjection,
  };
  state.events.push(event);
  dispatchEvent(event, 0).catch(() => {});
  return event;
}

async function dispatchEvent(event, attempt) {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const signingString = webhook.buildWebhookSigningString({
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp,
    nonce,
    keyId: PLATFORM_KEY_ID,
    rawBody: Buffer.from(rawBody, 'utf8'),
  });
  const signatureBase64 = crypto
    .createSign('RSA-SHA256')
    .update(signingString, 'utf8')
    .sign(platformPrivateKeyPem, 'base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-XD-Webhook-Signature': signatureBase64,
        'X-XD-Webhook-Key-Id': PLATFORM_KEY_ID,
        'X-XD-Webhook-Timestamp': String(timestamp),
        'X-XD-Webhook-Nonce': nonce,
        'X-XD-Webhook-Event-Id': event.eventId,
        'X-XD-Webhook-Event-Type': event.eventType,
      },
      body: rawBody,
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.status !== 200 || body !== 'success') {
      if (attempt < 8) {
        setTimeout(() => dispatchEvent(event, attempt + 1), 200 * (attempt + 1)).unref();
      }
    }
  } catch (error) {
    if (attempt < 8) setTimeout(() => dispatchEvent(event, attempt + 1), 200 * (attempt + 1)).unref();
  } finally {
    clearTimeout(timer);
  }
}

// ── 商家后端（真正签名调用平台） ──────────────────────────────────────
function merchantBaseUrl(req) {
  return `http://127.0.0.1:${PORT}`;
}

async function merchantCall(req, method, url, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const { headers } = sign.buildSignedHeaders({
    appId: APP_ID,
    keyId: KEY_ID,
    privateKeyPem: merchantPrivateKeyPem,
    method,
    url,
    contentType: 'application/json',
    body: raw,
  });
  const response = await fetch(`${merchantBaseUrl(req)}${url}`, {
    method,
    headers,
    body: method === 'POST' && raw ? raw : undefined,
  });
  const text = await response.text();
  log('merchant→platform', `${method} ${url} → ${response.status} ${text.slice(0, 160)}`);
  return { status: response.status, text };
}

// ── HTTP 基础设施 ────────────────────────────────────────────────────
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const filePath = path.join(PUBLIC_DIR, name);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    return true;
  }
  send(res, 200, fs.readFileSync(filePath), MIME[path.extname(filePath)] || 'application/octet-stream');
  return true;
}

function merchantWebhook(req, rawBody, res) {
  const valid = webhook.verifyWebhook({
    headers: req.headers,
    rawBody,
    platformPublicKeyPem,
  });
  if (!valid) {
    log('merchant', '事件验签失败（丢弃，不落账）');
    return send(res, 400, 'signature invalid', 'text/plain; charset=utf-8');
  }
  const event = JSON.parse(rawBody.toString('utf8'));
  if (state.merchantSeenEventIds.has(event.eventId)) {
    log('merchant', `事件重复投递，按 eventId 去重：${event.eventId}`);
    return send(res, 200, 'success', 'text/plain; charset=utf-8');
  }
  state.merchantSeenEventIds.add(event.eventId);
  state.merchantEvents.push(event);
  log('merchant', `验签通过并落账：${event.eventType} ${event.eventId}`);
  return send(res, 200, 'success', 'text/plain; charset=utf-8');
}

async function handle(req, res) {
  const [urlPath] = req.url.split('?');
  const rawBody = await readBody(req);

  // 模拟平台（先于静态回落：GET 查单也走这里）
  if (urlPath.startsWith('/mock/')) return mockRoutes(req, res, urlPath, rawBody);

  // 商家后端
  if (urlPath === '/state' || urlPath === '/merchant/state') return send(res, 200, JSON.stringify(snapshotForUi()));
  if (urlPath === '/merchant/webhook') return merchantWebhook(req, rawBody, res);
  if (urlPath.startsWith('/merchant/')) {
    const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    return merchantRoutes(req, res, urlPath, body);
  }

  // 收银页：/cashier/{token}（token 由页内自取，用于展示 payUrl）
  if (urlPath.startsWith('/cashier/')) return serveStatic(res, '/cashier.html');

  // 静态页面
  return serveStatic(res, urlPath);
}

// ── 商家后端路由 ─────────────────────────────────────────────────────
async function merchantRoutes(req, res, urlPath, body) {
  if (req.method === 'POST' && urlPath === '/merchant/orders') {
    const outTradeNo = body.outTradeNo || `DEMO${Date.now()}`;
    // ⚠️ 这不是生产请求体形状：为保持 demo **零外部依赖**，这里省掉了必填的
    // `payerClientIp` 且 `returnUrl` 用的是本机 http。生产请求体以
    // `docs/01-quickstart.md` §2 的六个必填字段为准（`payerClientIp` 必须是
    // 买家公网 IP、`returnUrl` 必须 https）——照抄本对象会在真实平台拿到 400。
    const called = await merchantCall(req, 'POST', '/mock/open/v1/payments', {
      outTradeNo,
      channel: body.channel || 'ALIPAY_H5',
      amountFen: 100,
      currency: 'CNY',
      subject: '本地 demo 商品',
      returnUrl: `http://127.0.0.1:${PORT}/?returned=${outTradeNo}`,
    });
    return send(res, called.status === 200 ? 200 : called.status, called.text);
  }
  const attempt = urlPath.match(/^\/merchant\/orders\/([^/]+)\/attempts$/);
  if (req.method === 'POST' && attempt) {
    const called = await merchantCall(req, 'POST', `/mock/open/v1/payments/${attempt[1]}/attempts`);
    return send(res, called.status, called.text);
  }
  const sync = urlPath.match(/^\/merchant\/orders\/([^/]+)\/sync$/);
  if (req.method === 'POST' && sync) {
    const called = await merchantCall(req, 'GET', `/mock/open/v1/payments/${sync[1]}`);
    return send(res, called.status, called.text);
  }
  const close = urlPath.match(/^\/merchant\/orders\/([^/]+)\/close$/);
  if (req.method === 'POST' && close) {
    const called = await merchantCall(req, 'POST', `/mock/open/v1/payments/${close[1]}/close`);
    return send(res, called.status, called.text);
  }
  const refund = urlPath.match(/^\/merchant\/orders\/([^/]+)\/refund$/);
  if (req.method === 'POST' && refund) {
    const called = await merchantCall(req, 'POST', '/mock/open/v1/refunds', {
      outTradeNo: refund[1],
      outRefundNo: `RF${Date.now()}`,
      refundAmountFen: 100,
      reason: '本地 demo 退款',
    });
    return send(res, called.status, called.text);
  }
  // 模拟买家完成支付（demo 里让页面能一键推进到终态）
  const pay = urlPath.match(/^\/merchant\/simulate\/([^/]+)\/pay$/);
  if (req.method === 'POST' && pay) {
    return send(res, 200, JSON.stringify(platformPay(pay[1])));
  }
  return send(res, 404, JSON.stringify({ code: 'NOT_FOUND' }));
}

function platformPay(outTradeNo) {
  const order = state.orders.get(outTradeNo);
  if (!order) return { ok: false, code: 'OPEN_API_RESOURCE_NOT_FOUND' };
  if (order.status === 'SUCCEEDED') return { ok: true, eventId: null };
  order.status = 'SUCCEEDED';
  order.attempts = order.attempts.map((attempt) => ({ ...attempt, state: 'PAID' }));
  const event = emitEvent(order, 'PAYMENT_SUCCEEDED');
  return { ok: true, eventId: event.eventId };
}

// ── 模拟平台路由 ─────────────────────────────────────────────────────
async function mockRoutes(req, res, urlPath, rawBody) {
  const auth = verifyMerchantRequest(req, rawBody);
  if (!auth.ok) return send(res, 401, JSON.stringify({ code: auth.code, message: '签名验证失败', requestId: '' }));

  if (req.method === 'POST' && urlPath === '/mock/open/v1/payments') {
    const body = JSON.parse(rawBody.toString('utf8'));
    const { replayed, order } = createOrder(body);
    return send(res, replayed ? 200 : 201, JSON.stringify({ requestId: auth.requestId, replayed, ...orderSnapshot(order, { includeMaterials: true }) }));
  }
  const attempts = urlPath.match(/^\/mock\/open\/v1\/payments\/([^/]+)\/attempts$/);
  if (req.method === 'POST' && attempts) {
    const order = state.orders.get(attempts[1]);
    if (!order) return send(res, 404, JSON.stringify({ code: 'OPEN_API_RESOURCE_NOT_FOUND' }));
    order.attempts = order.attempts.map((attempt) => (attempt.state === 'PENDING' ? { ...attempt, state: 'CLOSED' } : attempt));
    applyAttempt(order);
    return send(res, 201, JSON.stringify({ requestId: auth.requestId, ...orderSnapshot(order, { includeMaterials: true }) }));
  }
  const query = urlPath.match(/^\/mock\/open\/v1\/payments\/([^/]+)$/);
  if (req.method === 'GET' && query) {
    const order = state.orders.get(query[1]);
    if (!order) return send(res, 404, JSON.stringify({ code: 'OPEN_API_RESOURCE_NOT_FOUND' }));
    return send(res, 200, JSON.stringify({ requestId: auth.requestId, ...orderSnapshot(order, { includeMaterials: false }) }));
  }
  const close = urlPath.match(/^\/mock\/open\/v1\/payments\/([^/]+)\/close$/);
  if (req.method === 'POST' && close) {
    const order = state.orders.get(close[1]);
    if (!order) return send(res, 404, JSON.stringify({ code: 'OPEN_API_RESOURCE_NOT_FOUND' }));
    if (order.status === 'SUCCEEDED') {
      return send(res, 409, JSON.stringify({ code: 'OPEN_API_STATE_INVALID', message: '订单已支付，不能关单', requestId: auth.requestId }));
    }
    order.status = 'CLOSED';
    order.closedReason = 'MERCHANT_CLOSED';
    const event = emitEvent(order, 'PAYMENT_CLOSED');
    return send(res, 200, JSON.stringify({ requestId: auth.requestId, closeState: 'CLOSE_REQUESTED', eventId: event.eventId, order: orderSnapshot(order, { includeMaterials: false }) }));
  }
  if (req.method === 'POST' && urlPath === '/mock/open/v1/refunds') {
    const body = JSON.parse(rawBody.toString('utf8'));
    const order = state.orders.get(body.outTradeNo);
    if (!order) return send(res, 404, JSON.stringify({ code: 'OPEN_API_RESOURCE_NOT_FOUND', requestId: auth.requestId }));
    if (order.status !== 'SUCCEEDED') {
      return send(res, 409, JSON.stringify({ code: 'OPEN_API_STATE_INVALID', message: '仅已支付订单可退款', requestId: auth.requestId }));
    }
    if (state.refunds.has(body.outRefundNo)) {
      return send(res, 200, JSON.stringify({ requestId: auth.requestId, replayed: true, ...state.refunds.get(body.outRefundNo) }));
    }
    const refund = {
      refundAttemptId: `oprf_${crypto.randomBytes(13).toString('hex').toUpperCase()}`,
      outRefundNo: body.outRefundNo,
      outTradeNo: body.outTradeNo,
      openOrderId: order.openOrderId,
      amountFen: body.refundAmountFen,
      state: 'SUCCEEDED',
      reason: body.reason || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.refunds.set(body.outRefundNo, refund);
    const event = emitEvent(order, 'REFUND_SUCCEEDED', refund);
    return send(res, 201, JSON.stringify({ requestId: auth.requestId, ...refund, eventId: event.eventId }));
  }
  const refundQuery = urlPath.match(/^\/mock\/open\/v1\/refunds\/([^/]+)$/);
  if (req.method === 'GET' && refundQuery) {
    const refund = state.refunds.get(refundQuery[1]);
    if (!refund) return send(res, 404, JSON.stringify({ code: 'OPEN_API_RESOURCE_NOT_FOUND' }));
    return send(res, 200, JSON.stringify({ requestId: auth.requestId, ...refund }));
  }
  return send(res, 404, JSON.stringify({ code: 'OPEN_API_RESOURCE_NOT_FOUND' }));
}

function snapshotForUi() {
  return {
    orders: [...state.orders.values()].map((order) => ({
      ...orderSnapshot(order, { includeMaterials: true }),
      latestEventId: (state.events.filter((event) => event.outTradeNo === order.outTradeNo).pop() || {}).eventId || null,
    })),
    refunds: [...state.refunds.values()],
    events: state.events.slice(-20).reverse(),
    merchantEvents: state.merchantEvents.slice(-20).reverse(),
    log: state.merchantLog,
    config: { appId: APP_ID, keyId: KEY_ID, platformKeyId: PLATFORM_KEY_ID, notifyUrl: NOTIFY_URL, port: PORT },
  };
}

// ── 启动 ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    send(res, 500, JSON.stringify({ code: 'INTERNAL_ERROR', message: String(error && error.message) }));
  });
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`本地收银 demo 已启动：http://127.0.0.1:${PORT}/`);
    console.log(`  商家控制台   http://127.0.0.1:${PORT}/`);
    console.log(`  终端预览     http://127.0.0.1:${PORT}/preview.html`);
    console.log(`  事件投递地址 ${NOTIFY_URL}`);
    console.log('  仅 loopback + 内存：不连生产支付机构、不发起任何资金动作。');
  });
}

module.exports = { server, state, snapshotForUi, platformPay, createOrder };

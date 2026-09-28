#!/usr/bin/env node
'use strict';

/**
 * 本地收银 demo 冒烟：把 server.js 当真实进程拉起来，用 HTTP 走完整条链。
 *
 *   node demo/h5-cashier/smoke.js
 *
 * 覆盖：下单（支付宝/微信）→ 收款材料 → 重拉起换新码 → 查单（材料恒空）→
 * 关单 → 事件验签落账与 eventId 去重 → 退款 → 负向（未签名/签名篡改/未知单号）。
 * 只用 loopback 与内存；不连生产、不发起任何资金动作。
 */

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const failures = [];
const notes = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/state`);
      if (response.ok) return true;
    } catch (error) {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function http(port, method, urlPath, body, headers) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  return { status: response.status, text, json };
}

const state = (port) => http(port, 'GET', '/state');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  child.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  child.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  try {
    if (!(await waitForReady(port))) {
      throw new Error(`demo 服务未在超时内就绪：${serverLog.join('').slice(0, 400)}`);
    }

    console.log('\n[1] 下单与收款材料');
    const alipay = await http(port, 'POST', '/merchant/orders', { channel: 'ALIPAY_H5', outTradeNo: 'SMOKEALIPAY1' });
    check('支付宝下单返回 201', alipay.status === 201, `实际 ${alipay.status}`);
    check('下发 payUrl', typeof alipay.json?.payUrl === 'string' && alipay.json.payUrl.includes('/cashier/'));
    check('下发官方前缀 qrCode', String(alipay.json?.qrCode || '').startsWith('https://qr.alipay.com/'));
    check('links 为支付宝链', JSON.stringify(alipay.json?.links) === '["ALIPAY_AGGREGATION_NATIVE"]');

    const wechat = await http(port, 'POST', '/merchant/orders', { channel: 'WECHAT_H5', outTradeNo: 'SMOKEWECHAT1' });
    check('微信单不下发 qrCode', wechat.json?.qrCode === null);
    check('微信单仍下发 payUrl', typeof wechat.json?.payUrl === 'string');

    console.log('\n[2] 幂等与重拉起');
    const replay = await http(port, 'POST', '/merchant/orders', { channel: 'ALIPAY_H5', outTradeNo: 'SMOKEALIPAY1' });
    check('同号重放下单返回 200', replay.status === 200, `实际 ${replay.status}`);
    const attempts = await http(port, 'POST', '/merchant/orders/SMOKEALIPAY1/attempts');
    check('重拉起返回 201', attempts.status === 201, `实际 ${attempts.status}`);
    check('重拉起换了新码', attempts.json?.qrCode !== alipay.json?.qrCode, '新旧码相同');
    check('重拉起换了新 payUrl', attempts.json?.payUrl !== alipay.json?.payUrl, '新旧 payUrl 相同');

    console.log('\n[3] 查单是本地权威读（材料恒空）');
    const query = await http(port, 'POST', '/merchant/orders/SMOKEALIPAY1/sync');
    check('查单返回 200', query.status === 200, `实际 ${query.status}`);
    check('查单 payUrl 恒空', query.json?.payUrl === null);
    check('查单 qrCode 恒空', query.json?.qrCode === null);
    const missing = await http(port, 'POST', '/merchant/orders/SMOKENOPE/sync');
    check('未知单号中性 404', missing.status === 404, `实际 ${missing.status}`);

    console.log('\n[4] 支付终态只认事件与查单');
    const pay = await http(port, 'POST', '/merchant/simulate/SMOKEALIPAY1/pay');
    check('模拟支付推进成功', pay.json?.ok === true);
    await wait(600);
    let snapshot = (await state(port)).json;
    check(
      '商家侧已落账 PAYMENT_SUCCEEDED',
      snapshot.merchantEvents.some((event) => event.eventType === 'PAYMENT_SUCCEEDED'),
    );
    const paidEvent = snapshot.merchantEvents.find((event) => event.eventType === 'PAYMENT_SUCCEEDED');
    const beforeDedup = snapshot.merchantEvents.length;
    await http(port, 'POST', '/merchant/simulate/SMOKEALIPAY1/pay');
    await wait(300);
    snapshot = (await state(port)).json;
    check('重复事件按 eventId 去重', snapshot.merchantEvents.length === beforeDedup);
    check('落账事件带 feeProjection', Boolean(paidEvent?.feeProjection?.ruleVersion));
    check('查单可读到 SUCCEEDED 终态', (await http(port, 'POST', '/merchant/orders/SMOKEALIPAY1/sync')).json?.status === 'SUCCEEDED');

    console.log('\n[5] 关单');
    const close = await http(port, 'POST', '/merchant/orders/SMOKEWECHAT1/close');
    check('关单返回 CLOSE_REQUESTED', close.json?.closeState === 'CLOSE_REQUESTED', `实际 ${close.json?.closeState}`);
    await wait(400);
    snapshot = (await state(port)).json;
    check('关单事件已落账', snapshot.merchantEvents.some((event) => event.eventType === 'PAYMENT_CLOSED'));

    console.log('\n[6] 退款');
    const refund = await http(port, 'POST', '/merchant/orders/SMOKEALIPAY1/refund');
    check('退款受理返回 201', refund.status === 201, `实际 ${refund.status}`);
    check('退款终态 SUCCEEDED', refund.json?.state === 'SUCCEEDED', `实际 ${refund.json?.state}`);
    await wait(400);
    snapshot = (await state(port)).json;
    check('退款事件已落账', snapshot.merchantEvents.some((event) => event.eventType === 'REFUND_SUCCEEDED'));
    const unsettled = await http(port, 'POST', '/merchant/orders/SMOKEWECHAT1/refund');
    check('未支付订单退款被拒（409）', unsettled.status === 409, `实际 ${unsettled.status}`);

    console.log('\n[7] 负向：签名与验签');
    const unsigned = await http(port, 'POST', '/mock/open/v1/payments', { outTradeNo: 'SMOKEUNSIGNED1', channel: 'ALIPAY_H5' }, { 'X-XD-App-Id': 'xdop_demo000000000000' });
    check('未签名请求被 401 拒绝', unsigned.status === 401, `实际 ${unsigned.status}`);
    check('拒绝码为 OPEN_API_SIGNATURE_INVALID', unsigned.json?.code === 'OPEN_API_SIGNATURE_INVALID');
    const tampered = await http(port, 'POST', '/mock/open/v1/payments', { outTradeNo: 'SMOKETAMPER1', channel: 'ALIPAY_H5' }, {
      'X-XD-App-Id': 'xdop_demo000000000000',
      'X-XD-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-XD-Nonce': 'deadbeefdeadbeefdeadbeef',
      'X-XD-Key-Id': 'kid_demo_1',
      'X-XD-Request-Id': 'smoke-tampered-0001',
      'X-XD-Sign': 'A'.repeat(344),
    });
    check('签名篡改请求被 401 拒绝', tampered.status === 401, `实际 ${tampered.status}`);

    console.log('\n[8] 静态页面与终端矩阵（**只证明资源在位**）');
    // 注意本格的证明力边界：demo 的收银页是在**浏览器侧**按 terminal/channel
    // 分派的，服务端对 /cashier/preview 一律返回同一份 HTML，六个分支的文案
    // 都在这一份里。所以下面只证明「六个分支的判据文案确实在页面里」，**不构成
    // 「分派正确」的证据**（把分派钉死成任意一格，本格依然全绿）。分派行为请用
    // 浏览器打开预览页逐格切换真看，矩阵口径见 docs/06。
    for (const [name, needle] of [
      ['/cashier/preview?terminal=pc&channel=alipay', '请使用支付宝扫一扫完成付款'],
      ['/cashier/preview?terminal=pc&channel=wechat', '请使用微信扫码，在微信中完成支付'],
      ['/cashier/preview?terminal=wechat-out&channel=alipay', '打开支付宝'],
      ['/cashier/preview?terminal=wechat-out&channel=wechat', '复制链接并打开微信'],
      ['/cashier/preview?terminal=wechat-in&channel=alipay', '请在系统浏览器中打开本页面完成支付'],
      ['/cashier/preview?terminal=wechat-in&channel=wechat', '正在调起支付面板'],
    ]) {
      const page = await http(port, 'GET', name);
      check(`预览页分支文案在位：${name}`, page.status === 200 && page.text.includes(needle));
    }

    console.log('\n[9] 事件体与生产同形（关闭单金额恒 0、退款事件带 outRefundNo）');
    const eventSnapshot = (await state(port)).json;
    const events = eventSnapshot.events || [];
    const closedEvent = events.find((event) => event.eventType === 'PAYMENT_CLOSED');
    if (closedEvent) {
      check('关闭事件 eventAmountFen 恒为 0', closedEvent.eventAmountFen === 0,
        `实际 ${closedEvent.eventAmountFen}`);
      check('关闭事件 reason 回带真实关闭原因', closedEvent.reason === 'MERCHANT_CLOSED',
        `实际 ${String(closedEvent.reason)}`);
    } else {
      check('关闭事件存在', false, '未捕获到 PAYMENT_CLOSED');
    }
    const refundEvent = events.find((event) => event.eventType === 'REFUND_SUCCEEDED');
    if (refundEvent) {
      check('退款事件带 outRefundNo', typeof refundEvent.outRefundNo === 'string' && refundEvent.outRefundNo.length > 0,
        `实际 ${String(refundEvent.outRefundNo)}`);
      check('退款事件 status 是退款状态', refundEvent.status === 'SUCCEEDED', `实际 ${refundEvent.status}`);
    } else {
      check('退款事件存在', false, '未捕获到 REFUND_SUCCEEDED');
    }
    check('事件 stateVersion 恒为 0（与生产同形）',
      events.length > 0 && events.every((event) => event.stateVersion === 0),
      `实际 ${events.map((event) => event.stateVersion).join(',')}`);

    if (failures.length) {
      console.log(`\n[FAIL] demo 冒烟 ${failures.length} 项未通过：`);
      for (const item of failures) console.log(`  - ${item}`);
      process.exitCode = 1;
    } else {
      console.log(`\n[OK] demo 冒烟全部通过（loopback + 内存）${notes.length ? `；注：${notes.join('；')}` : ''}`);
    }
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(`[FAIL] demo 冒烟异常：${error.message}`);
  process.exit(1);
});

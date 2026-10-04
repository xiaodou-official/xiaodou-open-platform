#!/usr/bin/env node
'use strict';

/**
 * XD-Signature-v1 请求签名参考实现（Node.js，零依赖）。
 *
 * 规范串固定 11 行（每行以 \n 连接）：
 *   XD-Signature-v1
 *   {METHOD}            大写 ASCII
 *   {CANONICAL_PATH}    绝对路径（不含 host），URL 解码恰好一次
 *   {CANONICAL_QUERY}   RFC3986 重编码 + 键名排序；无 query 时为空行
 *   {TIMESTAMP}         秒级 epoch
 *   {NONCE}             一次性随机串（禁止复用）
 *   {APP_ID}
 *   {KEY_ID}
 *   {REQUEST_ID}
 *   {CONTENT_TYPE}      小写、去掉 `;` 参数
 *   {SHA256_HEX(rawBody)}  原始请求体字节的 SHA-256（小写十六进制）
 *
 * 签名算法 RSA-SHA256，签名值 Base64。
 *
 * 用法（库）：
 *   const { buildSignedHeaders } = require('./sign');
 *   const { headers } = buildSignedHeaders({ appId, keyId, privateKeyPem, method: 'POST', url: '/api/open/v1/payments?...', contentType: 'application/json', body: JSON.stringify(payload) });
 *
 * 用法（命令行，只做本地自检，不发起网络请求）：
 *   XD_APP_ID=... XD_KEY_ID=... XD_PRIVATE_KEY_PATH=./private_key.pem \
 *   node sign.js POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const SIGNATURE_VERSION = 'XD-Signature-v1';

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** RFC3986 严格编码：encodeURIComponent 之外补编 !'()* */
function rfc3986Encode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 路径：解码一次；拒绝路径穿越与别名写法（..、//、反斜杠、控制字符） */
function canonicalizePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '' || rawPath[0] !== '/' || rawPath.startsWith('//')) {
    throw new Error('路径必须是以 / 开头的绝对路径');
  }
  if (rawPath.includes('\\') || rawPath.includes('..')) {
    throw new Error('路径不得包含反斜杠或 ..');
  }
  const decoded = decodeURIComponent(rawPath);
  // eslint-disable-next-line no-control-regex
  if (decoded.includes('\\') || decoded.includes('..') || decoded.includes('//') || /[\u0000-\u001F\u007F]/.test(decoded)) {
    throw new Error('路径解码后含非法片段');
  }
  return decoded;
}

/** 查询串：逐键值解码一次 → RFC3986 重编码 → 按键名排序（重复键保留原相对顺序） */
function canonicalizeQuery(rawQuery) {
  if (typeof rawQuery !== 'string' || rawQuery === '') return '';
  const pairs = rawQuery.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, '%20'));
    const value = decodeURIComponent(rawValue.replace(/\+/g, '%20'));
    return { key: rfc3986Encode(key), value: rfc3986Encode(value) };
  });
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return pairs.map((p) => `${p.key}=${p.value}`).join('&');
}

/** Content-Type：小写、去 `;` 参数 */
function canonicalizeContentType(rawValue) {
  if (typeof rawValue !== 'string' || rawValue === '') return '';
  return rawValue.split(';', 1)[0].trim().toLowerCase();
}

/** 拆分绝对 URL 或 origin 相对地址为 canonicalPath / canonicalQuery */
function splitUrl(url) {
  const index = String(url).indexOf('?');
  const rawPath = index === -1 ? String(url) : String(url).slice(0, index);
  const rawQuery = index === -1 ? '' : String(url).slice(index + 1);
  return { path: canonicalizePath(rawPath), query: canonicalizeQuery(rawQuery) };
}

/** 构造 11 行规范串 */
function buildSigningString({
  method,
  path,
  query,
  timestamp,
  nonce,
  appId,
  keyId,
  requestId,
  contentType,
  rawBody,
}) {
  const upperMethod = String(method || '').toUpperCase();
  if (!/^[A-Z]+$/.test(upperMethod)) throw new Error('HTTP 方法非法');
  const body = rawBody === undefined || rawBody === null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'));
  return [
    SIGNATURE_VERSION,
    upperMethod,
    path,
    query,
    String(timestamp),
    String(nonce),
    String(appId),
    String(keyId),
    String(requestId),
    canonicalizeContentType(contentType),
    sha256Hex(body),
  ].join('\n');
}

function randomNonce() {
  return crypto.randomBytes(12).toString('hex'); // 24 位可见 ASCII
}

function randomRequestId() {
  return crypto.randomUUID();
}

/**
 * 生成可直接发送的六个签名头。
 * @param {object} p
 * @param {string} p.appId
 * @param {string} p.keyId
 * @param {string} p.privateKeyPem  PEM 私钥（只在本机内存中使用）
 * @param {string} p.method
 * @param {string} p.url 绝对路径 + 可选 query（不含 host）
 * @param {string} [p.contentType]
 * @param {string|Buffer} [p.body] 原始请求体（与真正发出去的字节完全一致）
 */
function buildSignedHeaders({
  appId,
  keyId,
  privateKeyPem,
  method,
  url,
  contentType = 'application/json',
  body = '',
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomNonce(),
  requestId = randomRequestId(),
}) {
  const { path, query } = splitUrl(url);
  const signingString = buildSigningString({
    method,
    path,
    query,
    timestamp,
    nonce,
    appId,
    keyId,
    requestId,
    contentType,
    rawBody: body,
  });
  const signatureBase64 = crypto
    .createSign('RSA-SHA256')
    .update(signingString, 'utf8')
    .sign(privateKeyPem, 'base64');
  return {
    signingString,
    signatureBase64,
    headers: {
      'Content-Type': contentType,
      'X-XD-App-Id': String(appId),
      'X-XD-Timestamp': String(timestamp),
      'X-XD-Nonce': nonce,
      'X-XD-Key-Id': String(keyId),
      'X-XD-Request-Id': requestId,
      'X-XD-Sign': signatureBase64,
    },
  };
}

module.exports = {
  SIGNATURE_VERSION,
  sha256Hex,
  rfc3986Encode,
  canonicalizePath,
  canonicalizeQuery,
  canonicalizeContentType,
  splitUrl,
  buildSigningString,
  buildSignedHeaders,
  randomNonce,
  randomRequestId,
};

if (require.main === module) {
  const [method = 'POST', url = '/api/open/v1/payments', body = ''] = process.argv.slice(2);
  const privateKeyPem = process.env.XD_PRIVATE_KEY_PATH
    ? fs.readFileSync(process.env.XD_PRIVATE_KEY_PATH, 'utf8')
    : process.env.XD_PRIVATE_KEY_PEM;
  if (!privateKeyPem) {
    console.error('请通过 XD_PRIVATE_KEY_PATH 或 XD_PRIVATE_KEY_PEM 提供私钥（仅本地自检用）');
    process.exit(1);
  }
  const result = buildSignedHeaders({
    appId: process.env.XD_APP_ID || 'xdop_example000000000',
    keyId: process.env.XD_KEY_ID || 'mkid_xxxxxxxxxxxxxxxx',
    privateKeyPem,
    method,
    url,
    contentType: process.env.XD_CONTENT_TYPE || 'application/json; charset=utf-8',
    body,
    // 可注入（golden 向量与回归用）：不注入时按当前时间随机生成。
    timestamp: process.env.XD_TIMESTAMP ? Number(process.env.XD_TIMESTAMP) : undefined,
    nonce: process.env.XD_NONCE || undefined,
    requestId: process.env.XD_REQUEST_ID || undefined,
  });
  console.log(result.signingString);
  console.log('---- headers ----');
  for (const [name, value] of Object.entries(result.headers)) {
    console.log(`${name}: ${value}`);
  }
}

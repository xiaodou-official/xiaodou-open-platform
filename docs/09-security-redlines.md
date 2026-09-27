# 安全红线

> docId：`XD-OP-09` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

这一篇是**必读**：下面每一条都有过真实事故。带 ❌ 的条目属于接入红线，违反会被平台风控处置。

## 1. 密钥纪律

- ✅ RSA2 密钥对在你**自己的服务器**上生成；公钥上传到门户，私钥留在本地受控存储。
- ❌ **私钥永不上传**给任何人（包括平台、包括「帮你调试」的人）。
- ❌ 私钥**永不进浏览器/小程序/App 前端**：签名只在你的服务端做。
- ❌ 私钥**不进代码仓库**、不进 CI 日志、不进镜像层。用密钥管理服务或受权限保护的凭证文件。
- ❌ **不把签名材料写进日志**（签名值、完整请求体、规范串都不行）。排障只需要 `requestId`。
- **一个应用一套密钥**；不要把同一套密钥复制到多个应用或多个环境。

## 2. 请求签名（`XD-Signature-v1`）

**六个头**：`X-XD-App-Id`、`X-XD-Timestamp`、`X-XD-Nonce`、`X-XD-Key-Id`、`X-XD-Request-Id`、`X-XD-Sign`。签名值 Base64（RSA-SHA256）。

待签名串固定 **11 行**，用 `\n` 连接：

```text
XD-Signature-v1
<METHOD>
<CANONICAL_PATH>
<CANONICAL_QUERY>
<TIMESTAMP>
<NONCE>
<APP_ID>
<KEY_ID>
<REQUEST_ID>
<CONTENT_TYPE>
<SHA256_HEX(rawBody)>
```

| 位置 | 规则（逐条都对，错一条就 401） |
| --- | --- |
| `METHOD` | 大写 ASCII（`GET`/`POST`） |
| `CANONICAL_PATH` | 绝对路径（**不含 host**），URL 解码**恰好一次**；不得含 `..`、重复斜杠、反斜杠、控制字符 |
| `CANONICAL_QUERY` | 键值各自解码一次后按 **RFC3986** 重编码；**键名排序**（重复键保留原相对顺序）；**无 query 时该行为空行** |
| `TIMESTAMP` | 秒级 epoch（强校验时间窗，服务器需 NTP 对时） |
| `NONCE` | 一次性随机串；**同一 nonce 复用会被判重放** |
| `APP_ID` / `KEY_ID` / `REQUEST_ID` | 与请求头**逐字一致** |
| `CONTENT_TYPE` | **小写**并**去掉 `;` 参数**（如 `application/json; charset=utf-8` → `application/json`） |
| `SHA256_HEX(rawBody)` | 对**原始请求体字节**做 SHA-256，小写十六进制；无请求体时为空串的哈希 |

> 编码差异**不会**被平台「帮你归一」：任何编码不同都表现为不同的规范路径/查询 → 签名不符。先用 [`examples/`](../examples/) 里的参考实现跑通，再改。

## 3. 响应验签（`XD-Response-v1`）

响应头：`X-XD-Response-Sign`、`X-XD-Response-Key-Id`、`X-XD-Response-Timestamp`、`X-XD-Response-Nonce`。待签名串 **8 行**：

```text
XD-Response-v1
<STATUS>
<CONTENT_TYPE>
<REQUEST_ID>
<TIMESTAMP>
<NONCE>
<KEY_ID>
<SHA256_HEX(rawBody)>
```

- 与请求签名**不是同一套拼串**，不要复用同一段代码。
- 平台公钥经**固定文档页与门户**双渠道发布（文档页见 [接入指南 · 平台公钥与指纹](./02-integration-guide.md#31-平台公钥与指纹公示)）；**不要在未验签的响应里取公钥**。

## 4. 事件验签（`XD-Webhook-v1`）

见 [webhook 验签](./05-webhook-verification.md)。要点复述：**7 行规范串**、从**原始字节**算哈希、按 `eventId` 去重、业务幂等、返回体字节正好是 `success`。

## 5. 回调与跳转

- ❌ **不信任任何未经签名校验的回调**：验签失败一律丢弃（哪怕内容看起来对）。
- ❌ **不要把回调当唯一真相**：必须接查单作为补偿路径（重复/乱序/丢失都要能自愈）。
- ✅ **`returnUrl` 一经使用即被冻结**；不要依赖「传新值改跳转目标」。
- ❌ **不要把交付内容（卡密、下载链接、密码）放进 `returnUrl` 的 query**——会被浏览器历史、日志、Referer 带走。交付只由你的服务端依据订单状态驱动。
- ❌ **不得把 `payUrl`/`qrCode` 转发到第三方站点或第三方二维码服务**（不得代理、不得改写、不得二次编码）。

## 6. 浏览器侧

- 收银页是**平台提供的页面**：按 [收银页对接](./06-cashier-integration.md) 的用法使用即可；商家自有页面里**不要**自行实现终端分派逻辑。
- ❌ 商家自有页面**不得**把平台返回的收款材料地址放进 `localStorage`/`sessionStorage`/Cookie。
- ❌ **不引入第三方 CDN / 统计 / 字体**到承载收款材料的页面（供应链面会被扩大，且可能泄露 Referer）。
- 收银链必须走 **HTTPS**；平台侧收银页带 `no-store` / `no-referrer` 等安全头，商家侧页面也不要放宽这些约束。

## 7. 请求来源

- 商家 API 校验**来源 IP**：出口 IP 需在门户白名单内。
- ❌ 不要把请求从不受控的代理/办公网出口发出；来源判定失败一律 `403`，且**不会**因为签名正确而放行。

## 8. 遇到拒绝时的正确反应

| 拒绝 | ❌ 错误反应 | ✅ 正确反应 |
| --- | --- | --- |
| `403 SOURCE_IP_REJECTED` | 换代理/换出口硬试 | 把出口 IP 加进门户白名单 |
| `422 CHANNEL_UNAVAILABLE` | 反复重试/换通道刷 | 按 [错误码与排障](./04-errors-and-troubleshooting.md) 判断是否为未放行通道，走门户反馈 |
| `429 RATE_LIMITED` | 紧循环重试 | 指数退避 + 复用 `requestId` |
| `503 GUARD_UNAVAILABLE` | 改换路径绕过 | 退避重试；`503` 是**安全地拒绝**，绕不过也不该绕 |

## 9. 泄露应急

怀疑私钥泄露：**立刻在门户轮换密钥**（见 [凭证与密钥管理](./12-credential-key-management.md)），并检查是否有人用旧密钥发起过请求。轮换后旧密钥进入失效流程，不需要你停机。

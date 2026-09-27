# 错误码与处置

> 人读版：`docs/04-errors-and-troubleshooting.md`（**不在本 Skill 包内**：Skill 包只含 `skill/**` 与 `examples/**`，需要时从门户「文档下载」包或公开仓的 `docs/` 取）。

失败响应**永不 2xx**，信封 `{code, message, requestId}`（唯一例外：`403 OPEN_API_SOURCE_IP_REJECTED` 另带 `details`，只含 `reason` 或 `appId`）。**判错只认 `code`**，`message` 只给人看；排障记录 `requestId`。

| code | HTTP | 一句话处置 |
| --- | --- | --- |
| `OPEN_API_HEADER_INVALID` | 400 | 六头缺失/重复/形态非法（**含 `Content-Type` 不是 `application/json`**）：按各头长度/字符集补全 |
| `OPEN_API_SIGNATURE_INVALID` | 401 | 验签失败（中性）：核对规范串、时间窗、nonce 唯一性、kid |
| `OPEN_API_SOURCE_IP_REJECTED` | 403 | 出口 IP 不在白名单：去门户加白（判定的是**平台边缘观测到的对端地址**，不是本机 `ifconfig` 看到的；不回头、不显示观测值） |
| `OPEN_API_RISK_FROZEN` | 403 | 应用被风控冻结：新增下单/尝试被拒，存量不受影响 |
| `OPEN_API_APP_SUSPENDED` | 403 | 应用被暂停：**实际拿到的是 `401`**（应用非 ACTIVE 时密钥解析在鉴权阶段就中性失败，防枚举）——商家 API **全部**打不通，存量订单的查询/关单/退款同样打不通，转平台人工通道 |
| `OPEN_API_APP_REVOKED` | 403 | 应用被吊销（永久终态）：**实际拿到的是 `401`**（同上，防枚举），全部不可用 |
| `OPEN_API_MERCHANT_INACTIVE` | 403 | 商家准入非 ACTIVE：新增下单/尝试被拒 |
| `OPEN_API_BODY_INVALID` | 400 | 请求体非法（含**未知字段**——请求体是严格模式） |
| `OPEN_API_PAYLOAD_TOO_LARGE` | 413 | 请求体超流式上限：精简字段 |
| `OPEN_API_REPLAY` | 409 | nonce 重放：每次请求用新 nonce |
| `OPEN_API_REQUEST_ID_CONFLICT` | 409 | 同 `requestId` 绑了不同请求体：重试要复用同一份 |
| `OPEN_API_IDEMPOTENCY_CONFLICT` | 409 | 同单号异内容：**先查单**，不要换号重下单 |
| `OPEN_API_RESOURCE_NOT_FOUND` | 404 | 中性不存在（含跨应用/跨商家） |
| `OPEN_API_STATE_INVALID` | 409 | 状态机非法迁移或终态冲突 |
| `OPEN_API_CHANNEL_UNAVAILABLE` | 422 | 通道链路未放行：**正常拒绝**，不要重试刷量 |
| `OPEN_API_CHANNEL_UNSUPPORTED` | 422 | 通道不受支持（预留词表位） |
| `OPEN_API_SCOPE_CHANNEL_MISMATCH` | 422 | 申报交易形态与通道绑定不符 |
| `OPEN_API_LIMIT_EXCEEDED` | 422 | 限额越界：先关掉在途未支付订单；限额无自助查询面，需调整走官网反馈渠道（附 `requestId`） |
| `OPEN_API_RATE_LIMITED` | 429 | 频率限流：指数退避 + 复用 `requestId` |
| `OPEN_API_PROVIDER_REJECTED` | 502 | 支付机构拒绝：先查单核对状态，不要原样无限重试 |
| `OPEN_API_GUARD_UNAVAILABLE` | 503 | 平台守卫不可用（fail-closed）：退避重试，**不要绕过** |

## 高频误区

| 现象 | 误解 | 正解 |
| --- | --- | --- |
| 403 | 「签名不对」 | 签名错是 401；403 一律是**来源或应用/商家状态** |
| 422 | 「系统故障，重试」 | 未放行通道/申报不符/限额——重试不会变成功 |
| 409 | 「换个单号重发」 | **先查单**；换号会造成两笔真实订单 |
| 503 | 「换个路径绕过」 | 503 是安全地拒绝；退避重试即可 |
| 404 | 「资源真的不存在」 | 查单对跨应用/跨商家统一中性 404，防枚举 |

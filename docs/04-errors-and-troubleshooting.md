# 错误码与排障

> docId：`XD-OP-04` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

## 1. 错误信封

失败响应**永不使用 2xx**，信封以三字段为准（另有两个码带 `details`：`403 OPEN_API_SOURCE_IP_REJECTED` 的**平台边缘腿**带 `details.reason`，`422 OPEN_API_LIMIT_EXCEEDED` 带触发面枚举——见下表对应行）：

```json
{ "code": "OPEN_API_BODY_INVALID", "message": "…可读说明…", "requestId": "018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55" }
```

`message` 是给人看的，**判错请只认 `code`**；排障请记录 `requestId`（向平台反馈时提供它最快）。

> **码空间是封闭的**：平台侧的内部故障（含支付机构链的内部异常）在到达你之前会被**中性化**——一律投影为本表内的 `503 OPEN_API_GUARD_UNAVAILABLE`，不会把内部码或内部原文透出。若你**确实**收到本表之外的 `code`（说明该口径被破），请按 `503` 语义处置并带 `requestId` 与 `code` 原文走官网反馈渠道；**不要**据此判断业务结果，更不要换单号重下单。

## 2. 错误码总表

| code | HTTP | 含义与处置 |
| --- | --- | --- |
| `OPEN_API_HEADER_INVALID` | 400 | 签名头缺失/重复/形态非法（**含 `Content-Type` 不是 `application/json`**）。检查六头是否成组、格式是否合规——各头的长度与字符集是硬约束，见表后的 [API 参考 · 请求头](./03-api-reference.md#1-通则)。 |
| `OPEN_API_SIGNATURE_INVALID` | 401 | 验签失败或应用/密钥解析失败（中性，不区分原因）。核对规范串、时间窗、nonce 唯一性。 |
| `OPEN_API_SOURCE_IP_REJECTED` | 403 | 来源 IP 判定失败。**两条腿处置不同**：① **平台边缘腿**——信封带 `details.reason`（七种取值见 [安全红线 · 请求来源](./09-security-redlines.md)），加白名单**无效**，请带 `requestId` 与出口 IP 走官网反馈；② **应用白名单腿**——信封只有三字段，把该出口 IP 加进门户白名单（含灾备出口）；你已自助关闭来源校验时**不会**出现这条腿。两条腿都**不回显**平台观测到的地址。 |
| `OPEN_API_RISK_FROZEN` | 403 | 应用被风控冻结：**新增**下单/支付尝试被拒；存量订单查询、关闭、退款与结算读回**不受影响**。 |
| `OPEN_API_APP_SUSPENDED` | 403 | 应用被暂停：商家 API 全部不可用。**实际拿到的是 `401`**——应用状态非 `ACTIVE` 时，密钥解析在**鉴权阶段**就中性失败（不区分「应用不存在」与「应用被暂停」，防枚举），这个 `403` 只在极窄的竞态窗口（鉴权通过后状态才变更）才可能返回。存量订单的查询/关单/退款同样打不通，转平台人工通道。 |
| `OPEN_API_APP_REVOKED` | 403 | 应用被吊销（**永久终态**）：商家 API 全部不可用，退款仅保留平台人工通道。同上，**实际拿到的是 `401`**。 |
| `OPEN_API_MERCHANT_INACTIVE` | 403 | 商家准入状态非 ACTIVE：**新增**下单/支付尝试被拒；存量订单不受影响。 |
| `OPEN_API_BODY_INVALID` | 400 | 请求体不是合法 JSON，或形状/枚举/边界违规（**含未知字段**）。 |
| `OPEN_API_PAYLOAD_TOO_LARGE` | 413 | 请求体超过流式硬上限。精简 `attach`/`description`。 |
| `OPEN_API_REPLAY` | 409 | nonce 重放命中。每次请求用新的 nonce。 |
| `OPEN_API_REQUEST_ID_CONFLICT` | 409 | 同 `requestId` 绑定了不同请求体。重试必须复用同一请求体。 |
| `OPEN_API_IDEMPOTENCY_CONFLICT` | 409 | 同 `outTradeNo`/`outRefundNo` 绑定了不同业务摘要。先查单，**不要换号重试**。 |
| `OPEN_API_RESOURCE_NOT_FOUND` | 404 | 资源不存在（查无/跨应用/跨商家/引用畸形统一中性）。 |
| `OPEN_API_STATE_INVALID` | 409 | 状态机非法迁移或终态冲突（例如对已成功订单再次关单）。 |
| `OPEN_API_CHANNEL_UNAVAILABLE` | 422 | 通道存在但链路未放行（闸门关闭或前置未齐）。**可预期的正常拒绝**，不要重试刷量。 |
| `OPEN_API_CHANNEL_UNSUPPORTED` | 422 | 通道不受支持（预留词表位）。 |
| `OPEN_API_SCOPE_CHANNEL_MISMATCH` | 422 | 申报交易形态与通道绑定不符（含越界/双申报缺省/空申报）。 |
| `OPEN_API_LIMIT_EXCEEDED` | 422 | 限额越界。信封带**触发面**：订单/尝试腿=`details.scopes`（数组）；**退款累计腿**=`details.scope` 单值 `REFUND_CUMULATIVE` + `outRefundNo`——枚举与处置见 [费率与限额](./07-fees-and-limits.md)。限额值不在任何页面展示：先关掉不再支付的在途订单；需要调整走官网反馈渠道（附 `requestId`）。 |
| `OPEN_API_RATE_LIMITED` | 429 | 频率限流越界。按响应头的窗口信息退避重试，**不要紧循环**。 |
| `OPEN_API_PROVIDER_REJECTED` | 502 | 支付机构拒绝本次请求（平台不向外暴露内部原因）。此类失败**不要原样无限重试**，先核对业务参数。 |
| `OPEN_API_GUARD_UNAVAILABLE` | 503 | 平台运行时守卫不可用（fail-closed）。**这是「安全地拒绝」而不是「未处理」**：按退避重试，不要改换路径绕过。 |

## 3. 排障决策树

```text
请求失败
├─ 400 → 六头形态（含每头长度/字符集）？→ 否：按 API 参考的请求头表补全
│        └ 是：Content-Type 是 application/json 吗？→ 否：写请求必须带它
│        └ 是：请求体有 schema 外字段、非法 JSON 或重复键？→ 去掉未知字段/修 JSON
├─ 401 → 规范串与实现逐字节对齐？→ 否：用[安全红线 · 响应验签](./09-security-redlines.md)的规范串定义重写拼串
│        └ 是：服务器时间是否准（NTP）？nonce 是否复用？kid 是否已轮换？**应用是否仍是
│            ACTIVE**（被暂停/吊销的表现在这一档，不报 403）？旧 kid 只在**你已申请开启的
│            限时宽限窗**内可用——默认不并行，轮换即原子切换（见[凭证与密钥管理](./12-credential-key-management.md)）
├─ 403 → 来源校验开启且出口在白名单内？→ 否：门户加白 / 开回校验
│        └ 是：应用/商家状态（风控冻结/商家准入失效）→ 按上表处置
├─ 404 → 是否用了别的应用的订单号？查询接口对跨应用/跨商家统一中性 404
├─ 409 → 先查单。幂等冲突=同号异内容；状态机冲突=动作与当前状态不符
├─ 413 → 精简请求体
├─ 422 → 通道链路未放行 / 申报不符 / 限额越界（三者 code 不同，按 code 分派）
├─ 429 → 退避重试（指数退避 + 上限），复用 requestId
├─ 502 → 支付机构拒绝：核对业务参数与订单状态，先查单再决定是否重试
├─ 503 → 平台守卫不可用（平台侧内部故障也中性投影到这一档）：退避重试；
│        不要据它判断业务结果、不要切换通道或改走非公开路径绕过
└─ 总表外的 code（不应出现）→ 按 503 语义处置并反馈
```

## 4. 三个高频误区

1. **把 403 当成「签名不对」**：签名错是 `401`；`403` 一律是**来源或状态**问题。
2. **把 `422 CHANNEL_UNAVAILABLE` 当故障重试**：它是产品口径的正常拒绝，重试不会变成功。
3. **`409` 之后换 `outTradeNo` 重下单**：会造成**两笔真实订单**。正确动作是查单。

## 5. 反馈给平台时请带上

`requestId`（响应头 `X-XD-Request-Id` 或错误信封里的 `requestId`）、发生时间（含时区）、`outTradeNo`、错误 `code`。**注意**：来源 IP 拒绝（`403`）、请求体门卫拒绝（`400`/`413`）与**六头形态非法（`400`）**这三类都不回头（`X-XD-Request-Id`），这类反馈请附上**错误体里的 `requestId` 或请求时间与出口 IP**；若信封里的 `requestId` 是空串（平台签名密钥不可用时的 `503`），以响应头为准。
**不要**把私钥、完整签名材料或买家个人信息贴进反馈。

## 6. 错误码镜像（机器校验，勿手改）

<!-- xd-contract-mirror:error-catalog -->
```json
{
  "errorCodes": {
    "OPEN_API_HEADER_INVALID": 400,
    "OPEN_API_SIGNATURE_INVALID": 401,
    "OPEN_API_SOURCE_IP_REJECTED": 403,
    "OPEN_API_RISK_FROZEN": 403,
    "OPEN_API_APP_SUSPENDED": 403,
    "OPEN_API_APP_REVOKED": 403,
    "OPEN_API_MERCHANT_INACTIVE": 403,
    "OPEN_API_PAYLOAD_TOO_LARGE": 413,
    "OPEN_API_BODY_INVALID": 400,
    "OPEN_API_REPLAY": 409,
    "OPEN_API_REQUEST_ID_CONFLICT": 409,
    "OPEN_API_IDEMPOTENCY_CONFLICT": 409,
    "OPEN_API_RESOURCE_NOT_FOUND": 404,
    "OPEN_API_CHANNEL_UNAVAILABLE": 422,
    "OPEN_API_CHANNEL_UNSUPPORTED": 422,
    "OPEN_API_SCOPE_CHANNEL_MISMATCH": 422,
    "OPEN_API_STATE_INVALID": 409,
    "OPEN_API_LIMIT_EXCEEDED": 422,
    "OPEN_API_RATE_LIMITED": 429,
    "OPEN_API_PROVIDER_REJECTED": 502,
    "OPEN_API_GUARD_UNAVAILABLE": 503
  }
}
```
<!-- /xd-contract-mirror:error-catalog -->

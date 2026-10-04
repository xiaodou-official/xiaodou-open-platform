# 事件通知：验签 / 去重 / 幂等落账

> 人读版：`docs/05-webhook-verification.md`（**不在本 Skill 包内**：Skill 包只含 `skill/**` 与 `examples/**`，需要时从门户「文档下载」包或公开仓的 `docs/` 取）。

## 0. 前置：`notifyUrl` 怎么配（配不上就没有任何事件）

- 应用级配置，在门户「应用配置变更」提交 → 短信二次验证后平台自动校验、**即时生效**（无人工审核环节）；**不是**下单请求体字段（写进下单体会因严格模式 `400`）。
- 四条硬约束：绝对 `https` 且公网可达；无 query/fragment；path 不是裸 `/`；**host 必须属于你已申报的域名**（归属验证可选，非生效判据）。
- **未配置（或校验未通过）= 平台不产生事件**（事件不落库，**事后补不回来**）——不要「先上线跑单、回头再补配置」。

## 1. 投递形态

`POST <你的 notifyUrl>`，头：`X-XD-Webhook-Signature`、`-Key-Id`、`-Timestamp`、`-Nonce`、`-Event-Id`、`-Event-Type`。**无 `Authorization`、无你的凭证、无买家 PII。**

## 2. 验签

规范串 **7 行**（`\n` 连接）：

```text
XD-Webhook-v1
{EVENT_ID}
{EVENT_TYPE}
{TIMESTAMP}
{NONCE}
{KEY_ID}
{SHA256_HEX(rawBody)}
```

- 六个取值全部来自**投递头**。
- `SHA256_HEX(rawBody)` 必须用**收到的原始字节**（框架里通常是未解析的 raw body）——用解析后再序列化的字符串算哈希是最常见的失败原因。
- 用平台公钥（固定文档页/门户发布，见 `docs/02-integration-guide.md` §3.1）做 RSA-SHA256 验签，按投递头 `X-XD-Webhook-Key-Id` 选对应公钥；验签失败**不落账**。

## 3. 你必须返回

- 成功：**2xx**，且响应体字节**正好**是 `success`（无 JSON 包装、无多余空白）。
- 其他都算投递失败 → 平台退避重试：**共投递 8 次**（首次即时 + 1m/5m/15m/1h/6h/24h/48h 退避），投递超时 **10 秒**，响应体超 **64KB** 也算失败，**不跟随 3xx**；用尽后转终止态——**平台不会自动感知**，需你自己用查单/日对账发现缺口后申请人工补推。
- 因此：**先持久化/落账、再返回成功**；不要返回成功后再异步处理。

## 4. 幂等与顺序

- `eventId` 是**幂等键**：建唯一索引；重复投递丢弃但**仍回 `success`**。
- 事件**可能乱序**：用**订单/退款状态机**判新旧（事件体 `stateVersion` 当前恒为 `0`，别用它），不要假设按时间到达。**`PAYMENT_CLOSED`/`PAYMENT_FAILED` 不是终点**：支付机构随后确认到账时订单会被提升为 `SUCCEEDED` 并推送 `PAYMENT_SUCCEEDED`，别把这两个状态建成吸收态。
- 事件体 `status` 是**事件主体自己**的状态：退款事件里它表示退款状态，不要拿订单状态去解释它。
- 事件**可能重复**（重试 + 人工补推）：去重必须覆盖这两条来源。

## 5. 事件类型

`PAYMENT_SUCCEEDED` / `PAYMENT_CLOSED` / `PAYMENT_FAILED` / `REFUND_SUCCEEDED` / `REFUND_FAILED`。
事件体字段：`eventId`、`eventType`、`appId`、`outTradeNo`、`outRefundNo`、`eventAmountFen`、`grossAmountFen`、`status`、`reason`（仅订单封闭词表）、`occurredAt`、`stateVersion`、`attach`、`feeProjection`。

## 6. 落账骨架

```text
收到投递
 ├─ 验签失败 → 记异常、丢弃、不回 success（配置问题，需人工介入）
 ├─ eventId 已处理 → 回 success（幂等）
 ├─ 目标状态不允许迁移（按状态机判） → 回 success（丢弃旧事件）
 ├─ 业务提交（状态迁移 + 交付动作，同一事务）
 │    ├─ 成功 → 标记 eventId → 回 success
 │    └─ 失败 → 不标记 → 返回非 2xx（让平台重试）
 └─ 长期失败 → 依赖补推或改为查单补偿任务
```

## 7. 与「回跳」的关系

收银页在买家点「返回商家」时的 `returnUrl` 跳转**不是**终态通知（也**不是自动跳转**）。落地页只做展示与轮询自己的服务端，不要用 query 里的任何东西当支付结果，也不要在页面里做交付。

## 8. 本地验证

`demo/h5-cashier/` 的模拟平台会真的按本规范签名并投递事件，商家侧消费者用 `examples/node/verify_webhook.js` 验签、按 `eventId` 去重：

```bash
node demo/h5-cashier/server.js    # 控制台里点「模拟买家完成支付」，看两侧事件表
node demo/h5-cashier/smoke.js     # 含重复投递去重与负向用例
```

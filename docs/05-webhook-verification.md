# webhook 验签

> docId：`XD-OP-05` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

平台把支付终态推送到你在应用里配置的 `notifyUrl`。本篇给出验签、去重、响应与补偿的完整做法。

> `notifyUrl` 是**应用级配置**（在门户的应用设置里维护，必须是 `https`、公网可达），**不是下单请求体字段**——把它写进下单请求体会因严格模式被 `400` 拒绝。未配置 `notifyUrl` 的应用不会产生事件投递。

## 1. 投递形态

```http
POST <你的 notifyUrl>
Content-Type: application/json
X-XD-Webhook-Signature: <Base64 签名值>
X-XD-Webhook-Key-Id: <平台密钥标识>
X-XD-Webhook-Timestamp: <秒级时间戳>
X-XD-Webhook-Nonce: <一次性随机串>
X-XD-Webhook-Event-Id: <事件唯一标识>
X-XD-Webhook-Event-Type: <事件类型>

{ …事件体… }
```

- 事件体是**平台侧的原始字节**：重推时**重签同字节**——所以验签必须用**收到的原始 body 字节**，不能先解析再序列化。
- 投递头里**没有** `Authorization`、没有你的凭证、没有买家的个人敏感信息。
- 验签用的**平台公钥**取自 [接入指南 · 平台公钥与指纹](./02-integration-guide.md#31-平台公钥与指纹公示)（与门户同源），按投递头里的 `X-XD-Webhook-Key-Id` 选择对应公钥。

## 2. 签名规范串（`XD-Webhook-v1`）

签名算法 **RSA-SHA256**（签名值 Base64）。待签名串按下面的顺序，用 `\n` 连接成 7 行：

```text
XD-Webhook-v1
<EVENT_ID>
<EVENT_TYPE>
<TIMESTAMP>
<NONCE>
<KEY_ID>
<SHA256_HEX(rawBody)>
```

- `SHA256_HEX(rawBody)`：对**收到的原始请求体字节**做 SHA-256，取小写十六进制。
- 六个取值全部来自投递头（`X-XD-Webhook-*`），不要从 body 里取。
- **不要复用请求签名的拼串逻辑**：三者（请求 / 响应 / 事件）是**三套不同的规范串**。

## 3. 验签步骤

```text
1. 取原始 body 字节（框架里通常是「未经 JSON 解析的 raw body」）
2. 按上节拼出 7 行规范串
3. 用平台公钥（RSA-SHA256 + Base64 签名）验签
4. 验签失败 → 丢弃并记异常（不要落账）
5. 验签通过 → 用 eventId 去重 → 业务处理 → 返回成功
```

参考实现：[`examples/node/verify_webhook.js`](../examples/node/verify_webhook.js)。

> ⚠️ 最常见的踩坑：用了框架里**已被解析过的对象**重新序列化成字符串去算哈希。中文字段、字段顺序、空格差异都会让哈希不同。**必须从原始字节算**。

## 4. 你必须返回什么

- 成功：HTTP **2xx**，且响应体字节**正好**是 `success`（不带 JSON 包装、不带多余空白）。
- 其他任何情况都视为**投递失败**，平台会**退避重试**（有次数上限）。
- 因此：**先落库去重、再返回成功**；不要在返回成功之后再异步处理（进程一旦退出事件就丢了）。
- 处理耗时较长时：先持久化事件、立即回 `success`，再由你自己的任务异步消费。

## 5. 幂等与乱序

- **`eventId` 是幂等键**：同一笔终态的多条路径会收敛到**同一个 `eventId`**。请对它建唯一索引，重复投递直接丢弃并回 `success`。
- **可能乱序**：不要假设事件按时间到达。用 `stateVersion`（单调递增）判新旧，或用订单状态机判「当前状态是否允许迁移到目标状态」。
- **可能重复**：重试与人工补推都会造成同一事件多次到达，去重必须覆盖这两条来源。

## 6. 事件类型与事件体

| `eventType` | 何时产生 |
| --- | --- |
| `PAYMENT_SUCCEEDED` | 订单支付成功（终态） |
| `PAYMENT_CLOSED` | 订单关闭（过期/商家关闭/支付机构关闭） |
| `PAYMENT_FAILED` | 支付机构明确回读确认**未支付**并进入失败态时 |
| `REFUND_SUCCEEDED` | 退款成功 |
| `REFUND_FAILED` | 退款失败 |

事件体字段：`eventId`、`eventType`、`appId`、`outTradeNo`、`outRefundNo`（可空）、`eventAmountFen`、`grossAmountFen`、`status`、`reason`（仅订单封闭词表；**支付机构内部原因永不出现在事件体**）、`occurredAt`（UTC epoch 秒）、`stateVersion`、`attach`（你下单时的附加数据原样回带）、`feeProjection`。

> **两个金额字段别用混**：`grossAmountFen` 恒为**关联订单总额**；`eventAmountFen` 是**本事件对应的金额**——订单事件里**只有 `PAYMENT_SUCCEEDED` 才有实付金额，关闭/失败事件恒为 `0`**；退款事件里是退款金额。要按事件落账，请以 `grossAmountFen`（订单总额）为准、`eventAmountFen` 只在该事件确实发生资金变动时使用。

> **`reason` 是订单关闭原因的子集**：事件里只会出现 `EXPIRED` / `MERCHANT_CLOSED` / `PROVIDER_CLOSED` 三个值。`CLOSE_REQUESTED` 是**关单请求的中间态**（「已受理」），**不会**出现在事件体里——关单真正生效时产生的事件是 `PAYMENT_CLOSED`。其余事件类型的 `reason` 为空，请对空值做兼容。

字段名与枚举的机器镜像见 [API 参考 · 合同镜像](./03-api-reference.md#4-合同镜像机器校验勿手改)。

## 7. 幂等落账骨架

```text
收到投递
 ├─ 验签失败 → 记异常，丢弃（不回 success，让平台重试也别回：这是配置问题，需人工介入）
 ├─ eventId 已处理 → 回 success（幂等）
 ├─ stateVersion 老于已记录版本 → 回 success（丢弃旧事件）
 ├─ 业务提交（订单/退款状态迁移 + 你的交付动作，同一事务）
 │    ├─ 成功 → 标记 eventId 已处理 → 回 success
 │    └─ 失败 → 不标记 → 返回非 2xx（让平台重试）
 └─ 已知会长期失败的 → 依赖平台补推或改为主动查单补偿
```

## 8. 与「回跳」的关系

收银页支付完成后会把买家浏览器跳回 `returnUrl`——那是**给你做 UX 的**（展示「支付处理中/已完成」），**不是**终态通知。你的 `returnUrl` 落地页应当：只展示、只轮询自己的服务端，**不要**用 query 参数里的任何东西当支付结果，也**不要**在页面里做交付。

## 9. 本地怎么测

`demo/h5-cashier/` 的 mock 平台会真的按上面的规范串签名并投递事件，附带一个验签消费者示例，可直接对着改：

```bash
node demo/h5-cashier/server.js
```

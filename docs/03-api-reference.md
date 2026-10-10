# API 参考

> docId：`XD-OP-03` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

商家服务端 API。所有路径都相对于你的 `<BASE_URL>`。

## 1. 通则

**请求头（六头成组，缺一即 `400`）**

| 头 | 说明 |
| --- | --- |
| `X-XD-App-Id` | 应用标识（`xdop_` + 16 位字母数字） |
| `X-XD-Timestamp` | 秒级时间戳（强校验时间窗；≤10 位数字） |
| `X-XD-Nonce` | 一次性随机串（防重放；同一 nonce 不可复用）。**16–64 位可见 ASCII**（`!` 到 `~`，不含空白与控制字符） |
| `X-XD-Key-Id` | 签名密钥标识（与你的公钥成对）；1–128 位可见 ASCII |
| `X-XD-Request-Id` | 请求级幂等标识（重试必须复用同一个值）；**8–128 位**，字符集 `A-Z a-z 0-9 . _ : -` |
| `X-XD-Sign` | Base64 签名值（RSA-SHA256；RSA-2048 约 344 字符）。**64–1024 位可见 ASCII**（`!` 到 `~`） |

> **头是「逐字比对」的**：上面的字符集与长度都是硬约束，越界与缺失返回**同一个** `400 OPEN_API_HEADER_INVALID`（错误体不会指出是哪一头；唯一例外：同名头重复的 `400` 会在 message 里点名该头——每个头只提交一次即可避开）——排障时先按本表逐头核形态，再怀疑签名。

**`Content-Type`**：**写方法（`POST`）必须带 `Content-Type: application/json`**（允许带 `charset` 参数；服务端会小写化并去掉 `;` 参数后比对）。这条对**没有请求体的两个端点**（重拉起、关单）同样成立——`GET` 可以不带。**`GET` 不带时，参与签名的是空行**（不是 `application/json`）：签名串里写的是「你实际发出的那个头」的规范化值，没发就是空——见 [安全红线 · 请求签名](./09-security-redlines.md)。
请求体本身：带请求体的两个端点（创建订单、创建退款）是**严格模式**，多传 schema 之外的字段直接 `400`；重拉起/关单/查单/退款查询**没有请求体字段**，请求体可省略（发了合法 JSON 也被忽略，但**非法 JSON、重复键、超出 64KB 仍会 `400`/`413`**）。

**响应头**

- `X-XD-Request-Id`：请求身份回显——**验签通过之后的每一道拒绝都带**（含重放预检、限流、状态机、支付机构拒绝），排障时先看它。
- **三道更早的拒绝不带这个响应头**，此时 `requestId` 只在错误体里返回，按**实际发生顺序**是：① **请求体门卫拒绝（`400`/`413`：非法 JSON、重复键、超出 64KB 上限）**；② **来源 IP 判定失败（`403`）**；③ **六头缺失或形态非法（`400`）**——因为回显本身就是「六头已通过形态校验」之后才做的事。（`Content-Type` 不是 `application/json` 的 `400` 属于**第三道之后**，带这个头。）
- `X-XD-Response-Sign` / `-Key-Id` / `-Timestamp` / `-Nonce`：响应签名四头，验签方法见 [安全红线](./09-security-redlines.md)。**鉴权链之前的拒绝（来源 IP、请求体门卫、六头形态、验签失败、重放）不带这四个头**——验签只在四头齐备时强制，缺头不等于被篡改。**另有一种不带的情况**：平台签名密钥不可用时的 `503`（错误体 `requestId` 为空串，请改取响应头 `X-XD-Request-Id`）。
- **路径或方法写错时拿到的不是本文档描述的信封**：未挂载到开放平台路由的路径/方法由平台通用兜底处理（信封形状与本文档不同）。遇到「`code` 看起来不像 `OPEN_API_*`」的响应，先核对路径与方法拼写。

**信封**

- 成功：`{ "requestId": "...", ...业务字段 }`
- 失败：`{ "code": "...", "message": "...", "requestId": "..." }` —— 失败**永不**返回 2xx，`code` **只在总表内**（平台侧内部故障投影为 `503 OPEN_API_GUARD_UNAVAILABLE`，不会把内部码透给你）。
- `details` 字段**只在两个码上出现**：① **平台边缘腿**的来源 IP 拒绝（`403 OPEN_API_SOURCE_IP_REJECTED`）带 `details.reason`（七种取值见 [安全红线 · 请求来源](./09-security-redlines.md)），**不会回显**平台观测到的地址；② **限额越界**（`OPEN_API_LIMIT_EXCEEDED`，HTTP 状态见 [错误码与排障](./04-errors-and-troubleshooting.md) 总表）带**触发面**——订单/尝试腿=`details.scopes`（枚举见 [费率与限额](./07-fees-and-limits.md)），**退款累计腿**=`details.scope` 单值 `REFUND_CUMULATIVE` + `outRefundNo`。**应用白名单腿**的同一个 `403` 只有三字段。

**通用约定**：金额整数分（`Fen`）；**带请求体的两个端点**（创建订单、创建退款）是**严格模式**——多传 schema 之外的字段直接 `400`；其余端点（重拉起、查单、关单、退款查询）**不接受请求体**，带了也不会被解析（不要指望它报错）。错误码只取 [错误码与排障](./04-errors-and-troubleshooting.md) 的总表。**任何端点**都可能返回 `413`（请求体超过流式上限）；平台侧内部故障一律投影为 **`503 OPEN_API_GUARD_UNAVAILABLE`**（不会出现表外码，也不会有 `500`）；请求列字段约束见 [§2.7](#27-请求字段约束创建订单--创建退款)。

## 2. 端点

### 2.1 `POST /api/open/v1/payments` — 创建支付订单（业务幂等）

| 项 | 值 |
| --- | --- |
| 成功 | `201`（新建）/ `200`（同 `outTradeNo` 同业务摘要 → 幂等重放，含 `replayed=true`） |
| 失败 | `400` `401` `403` `409` `422` `429` `502` `503` |
| 请求体 | `outTradeNo`、`channel`、`amountFen`、`currency`、`subject`、**`payerClientIp`** 必填；`tradeScope`、`description`、`attach`、`returnUrl` 可选 |

要点：

- 同 `outTradeNo` 异业务摘要 → `409`（冲突），**不要换号重试**。
- 幂等重放返回的是**订单当前快照**：存在有效支付尝试时含有效 `payUrl`；尝试已终态/过期时 `payUrl` 为空并附 `nextAction=CREATE_ATTEMPT`，且**不回传过期支付材料**。
- 支付宝渠道在**下发响应**中另含 `qrCode`（官方收款码，服务端校验后下发）。
- `returnUrl` **属于业务摘要**：同一个 `outTradeNo` 重试时必须**逐字复用它**——传不同值不是「被忽略」，而是 `409 OPEN_API_IDEMPOTENCY_CONFLICT`（摘要成员见 [§2.7](#27-请求字段约束创建订单--创建退款)）。它的目标在首次下单时冻结。
- `payerClientIp` 是**必填**字段：买家客户端的公网 IP，由**你的服务端转交**（填写合法公网 IPv4/IPv6，不要填内网或保留地址）。它用于风控提示，平台不会替你解析代理链；缺失或非法一律 `400`。

### 2.2 `POST /api/open/v1/payments/{outTradeNo}/attempts` — 重拉起支付尝试

| 项 | 值 |
| --- | --- |
| 成功 | `201`（新尝试）/ `200`（并发赢家投影） |
| 失败 | `400` `401` `403` `404` `409` `422` `429` `502` `503` |
| 请求体 | 无（写方法仍须 `Content-Type: application/json`） |

要点：

- 语义是「**关旧建新**」：仅关闭处于进行中的旧尝试（状态不确定的尝试按纪律**不判死**），并创建新尝试。
- 返回的是**新材料**：`payUrl` 与 `qrCode` 同批更换，**旧码不可复用**。
- 需要新收款材料时**只用这个端点**，不要重复调用下单接口。

### 2.3 `GET /api/open/v1/payments/{outTradeNo}` — 查询订单

| 项 | 值 |
| --- | --- |
| 成功 | `200` |
| 失败 | `400` `401` `403` `404` `409` `429` `503` |

> 这里的 `409` 是**重放防护**（复用同一个 `nonce` 才会命中）；查询是只读的，没有状态机冲突。

要点：

- **本地权威读**：只读本地账本，不因查询刷量触发外部外呼，不改账、不重签收款材料。
- **`payUrl` 与 `qrCode` 恒为 `null`**：查询接口不重签材料；需要材料时走幂等重放或重拉起端点。
- 查无、跨应用、跨商家、引用畸形**统一返回中性 `404`**（这是防枚举设计，不要据此推断资源是否存在）。

### 2.4 `POST /api/open/v1/payments/{outTradeNo}/close` — 关闭订单

| 项 | 值 |
| --- | --- |
| 成功 | `200`（含 `closeState` + 订单快照） |
| 失败 | `400` `401` `403` `404` `409` `422` `429` `502` `503` |
| 请求体 | 无（写方法仍须 `Content-Type: application/json`） |

`closeState` 取值：`CLOSE_REQUESTED`（已受理关闭）/ `ALREADY_CLOSED`（本就已关闭）/ `UNKNOWN_KEPT`（结果不确定，**维持原状不判死**）/ `PROVIDER_PAID_CONFLICT`（关单过程中发现已支付，订单转成功）。

> **`closeState` 只出现在 `200` 回执里**。若平台在**受理关单之前**就已判定该单已支付，走的是另一条路径：直接返回 `409` `OPEN_API_STATE_INVALID`，错误体只有 `code`/`message`/`requestId`，**不含 `closeState`**；`PROVIDER_PAID_CONFLICT` 只出现在「平台与支付机构在关单过程中同时收敛到终态」的并发场景，且以 `200` 回执返回。两条路径的正确动作相同：**先查单确认终态，不要重试关单**。

要点：关闭前平台会先与支付机构确认**未支付**才真正关闭；**已支付的订单不会被盲目关掉**。

### 2.5 `POST /api/open/v1/refunds` — 创建退款（业务幂等）

| 项 | 值 |
| --- | --- |
| 成功 | `201`（受理）/ `200`（同 `outRefundNo` 同内容幂等重放） |
| 失败 | `400` `401` `403` `404` `409` `422` `429` `502` `503` |
| 请求体 | `outTradeNo`、`outRefundNo`、`refundAmountFen` 必填；`reason` 可选 |

要点：仅**支付成功**的订单可退；累计退款不得超过实付（失败的退款不占额度）；受理后被支付机构拒绝返回 `502`；传输不确定时状态为 `UNKNOWN`（**不判死**，等事件或退查收敛）。

### 2.6 `GET /api/open/v1/refunds/{outRefundNo}` — 查询退款

| 项 | 值 |
| --- | --- |
| 成功 | `200` |
| 失败 | `400` `401` `403` `404` `409` `429` `503` |

> 这里的 `409` 同样是**重放防护**（复用 `nonce`），与订单查询同一条链。

只读本地权威退款状态，不返回内部材料与摘要。返回投影中的 `replayed` 恒为 `true`（表示这是既有记录的投影），**不要**把它解读为「发生过幂等重放」。

### 2.7 请求字段约束（创建订单 / 创建退款）

下表是**逐字硬约束**（不是建议）：任何一条不满足返回 `400 OPEN_API_BODY_INVALID`——**不是** `422`。`422` 只用于通道、申报形态与平台限额（见 [费率与限额](./07-fees-and-limits.md)）。

| 字段 | 约束 |
| --- | --- |
| `outTradeNo` / `outRefundNo` | **6–64 位**，字符集仅 `A-Z a-z 0-9 _ -`（**不能含点号**、空格、中文或其他符号）；同一笔重试必须逐字复用 |
| `amountFen` | 整数分，**`1` – `2000000`**（¥0.01 – ¥2 万）；更小的值、小数点、字符串都会被拒 |
| `currency` | 固定 `CNY`（**大小写敏感**，`cny`/`RMB` 都会被拒） |
| `subject` | 必填，≤ **128** 字符 |
| `description` | 可选，≤ **256** 字符 |
| `attach` | 可选，≤ **256** 字符；按事件**原样回带**（首尾空白会被去掉） |
| `returnUrl` | 可选，绝对 **`https`**（不得带 userinfo、不得带 query/fragment），≤ **512** 字符 |
| `payerClientIp` | 必填，**合法公网** IPv4/IPv6——内网 / 保留段 / 文档示例段（`10/8`、`172.16/12`、`192.168/16`、`127/8`、CGNAT、`203.0.113/24` 等）一律拒绝 |
| `refundAmountFen` | 整数分且 > `0`；同一订单累计不得超过实付（失败的退款不占额度） |
| `reason`（退款） | 可选，≤ **256** 字符 |

**业务摘要成员**（决定「同号同内容 → 幂等重放」还是「同号异内容 → `409`」）：`channel`、`tradeScope`、`amountFen`、`currency`、`subject`、`description`、`returnUrl`、`attach`。**`payerClientIp` 不参与**——它可以在重试时按实际情况变化，不会触发 `409`。

## 3. 数据模型

### 3.1 订单快照（`OrderSnapshot`）

| 字段 | 说明 |
| --- | --- |
| `openOrderId` | 平台订单号 |
| `outTradeNo` | 你的订单号（幂等身份） |
| `status` | 订单状态（枚举见下） |
| `closedReason` | 关闭原因（可空） |
| `channel` / `tradeScope` | 通道 / 申报交易形态（下单时冻结） |
| `links` | 该单冻结的支付链集合（永不包含已作废链） |
| `amountFen` / `currency` | 金额（整数分）/ 币种 |
| `attach` | 你的附加数据（事件原样回带） |
| `expireAt` | 支付窗口截止（以服务端为准） |
| `payUrl` | 平台收银页地址（**非下发响应恒空**：查询与关单回执都是 `null`） |
| `qrCode` | 官方收款码（仅下发响应、仅支付宝渠道；查询与关单回执恒空） |
| `payUrlExpireHint` | 收款材料失效提示（UTC epoch 秒）。**取值跟随订单支付窗口 `expireAt`**，不是收银材料自身的寿命——需要新码一律走重拉起 |
| `nextAction` | 可支付但无有效尝试时引导重拉起（`CREATE_ATTEMPT`）；**只在需要时出现**，无该字段即不需要 |
| `latestAttempt` | 最近一次支付尝试的状态与到期时间（**仅查询投影**；关单回执里为 `null`），不含任何材料 |
| `feeProjection` | 该笔的费率投影（见 [费率与限额](./07-fees-and-limits.md)） |
| `replayed` / `unknown` | 是否幂等重放 / 状态是否不确定（**仅下单与重拉起响应**；查询/关单投影不含这两个字段）。`unknown` **只在为真时出现**，不要按「字段必在」解析 |

### 3.2 退款投影（`RefundProjection`）

`refundAttemptId`、`outRefundNo`、`outTradeNo`、`openOrderId`、`amountFen`、`state`、`reason`、`createdAt`、`updatedAt`、`replayed`、`unknown`。

### 3.3 事件体（`WebhookEventPayload`）

见 [webhook 验签](./05-webhook-verification.md)。

## 4. 合同镜像（机器校验，勿手改）

下面两个块由门禁从接口合同与错误码总表派生，**与合同的任何不一致都会阻断候选**。改接口必须先改合同、再重生成镜像。

<!-- xd-contract-mirror:openapi -->
```json
{
  "paths": [
    "/payments",
    "/payments/{outTradeNo}",
    "/payments/{outTradeNo}/attempts",
    "/payments/{outTradeNo}/close",
    "/refunds",
    "/refunds/{outRefundNo}"
  ],
  "channel": [
    "ALIPAY_H5",
    "WECHAT_H5"
  ],
  "tradeScope": [
    "PHYSICAL_FACE_TO_FACE",
    "CARD_VIRTUAL"
  ],
  "orderStatus": [
    "CREATED",
    "PAYING",
    "SUCCEEDED",
    "CLOSED",
    "FAILED",
    "UNKNOWN"
  ],
  "closedReason": [
    "EXPIRED",
    "CLOSE_REQUESTED",
    "PROVIDER_CLOSED",
    "MERCHANT_CLOSED"
  ],
  "refundState": [
    "REQUESTED",
    "PENDING",
    "SUCCEEDED",
    "FAILED",
    "UNKNOWN"
  ],
  "attemptState": [
    "PENDING",
    "ACCEPTED",
    "UNKNOWN",
    "PAID",
    "CLOSED",
    "FAILED"
  ],
  "link": [
    "ALIPAY_AGGREGATION_NATIVE",
    "WECHAT_JSAPI"
  ],
  "webhookEventType": [
    "PAYMENT_SUCCEEDED",
    "PAYMENT_CLOSED",
    "PAYMENT_FAILED",
    "REFUND_SUCCEEDED",
    "REFUND_FAILED"
  ],
  "fields": {
    "OrderSnapshot": [
      "amountFen",
      "attach",
      "channel",
      "closedReason",
      "currency",
      "expireAt",
      "feeProjection",
      "latestAttempt",
      "links",
      "nextAction",
      "openOrderId",
      "outTradeNo",
      "payUrl",
      "payUrlExpireHint",
      "qrCode",
      "replayed",
      "status",
      "tradeScope",
      "unknown"
    ],
    "RefundProjection": [
      "amountFen",
      "createdAt",
      "openOrderId",
      "outRefundNo",
      "outTradeNo",
      "reason",
      "refundAttemptId",
      "replayed",
      "state",
      "unknown",
      "updatedAt"
    ],
    "CreatePaymentRequest": [
      "amountFen",
      "attach",
      "channel",
      "currency",
      "description",
      "outTradeNo",
      "payerClientIp",
      "returnUrl",
      "subject",
      "tradeScope"
    ],
    "CreateRefundRequest": [
      "outRefundNo",
      "outTradeNo",
      "reason",
      "refundAmountFen"
    ],
    "WebhookEventPayload": [
      "appId",
      "attach",
      "eventAmountFen",
      "eventId",
      "eventType",
      "feeProjection",
      "grossAmountFen",
      "occurredAt",
      "outRefundNo",
      "outTradeNo",
      "reason",
      "stateVersion",
      "status"
    ],
    "FeeProjection": [
      "companyServiceFeeFen",
      "companyServiceFeeRateBps",
      "merchantRateBps",
      "merchantSettlementFen",
      "ruleVersion",
      "thresholdFen",
      "tier"
    ]
  }
}
```
<!-- /xd-contract-mirror:openapi -->

# API 参考

> docId：`XD-OP-03` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

商家服务端 API。所有路径都相对于你的 `<BASE_URL>`。

## 1. 通则

**请求头（六头成组，缺一即 `400`）**

| 头 | 说明 |
| --- | --- |
| `X-XD-App-Id` | 应用标识 |
| `X-XD-Timestamp` | 秒级时间戳（强校验时间窗） |
| `X-XD-Nonce` | 一次性随机串（防重放；同一 nonce 不可复用） |
| `X-XD-Key-Id` | 签名密钥标识（与你的公钥成对） |
| `X-XD-Request-Id` | 请求级幂等标识（重试必须复用同一个值） |
| `X-XD-Sign` | Base64 签名值（RSA-SHA256） |

**响应头**

- `X-XD-Request-Id`：请求身份回显——**验签通过之后的每一道拒绝都带**（含重放预检、限流、状态机、支付机构拒绝），排障时先看它。
- **两道更早的拒绝不带这个响应头**，此时 `requestId` 只在错误体里返回：① **来源 IP 判定失败（`403`）**发生得最早；② **六头缺失或形态非法（`400`）**——因为回显本身就是「六头已通过形态校验」之后才做的事。
- `X-XD-Response-Sign` / `-Key-Id` / `-Timestamp` / `-Nonce`：响应签名四头，验签方法见 [安全红线](./09-security-redlines.md)。

**信封**

- 成功：`{ "requestId": "...", ...业务字段 }`
- 失败：`{ "code": "...", "message": "...", "requestId": "..." }` —— 失败**永不**返回 2xx。

**通用约定**：金额整数分（`Fen`）；**带请求体的两个端点**（创建订单、创建退款）是**严格模式**——多传 schema 之外的字段直接 `400`；其余端点（重拉起、查单、关单、退款查询）**不接受请求体**，带了也不会被解析（不要指望它报错）。错误码只取 [错误码与排障](./04-errors-and-troubleshooting.md) 的总表。

## 2. 端点

### 2.1 `POST /api/open/v1/payments` — 创建支付订单（业务幂等）

| 项 | 值 |
| --- | --- |
| 成功 | `201`（新建）/ `200`（同 `outTradeNo` 同业务摘要 → 幂等重放，含 `replayed=true`） |
| 失败 | `400` `401` `403` `404` `409` `422` `429` `502` `503` |
| 请求体 | `outTradeNo`、`channel`、`amountFen`、`currency`、`subject`、**`payerClientIp`** 必填；`tradeScope`、`description`、`attach`、`returnUrl` 可选 |

要点：

- 同 `outTradeNo` 异业务摘要 → `409`（冲突），**不要换号重试**。
- 幂等重放返回的是**订单当前快照**：存在有效支付尝试时含有效 `payUrl`；尝试已终态/过期时 `payUrl` 为空并附 `nextAction=CREATE_ATTEMPT`，且**不回传过期支付材料**。
- 支付宝渠道在**下发响应**中另含 `qrCode`（官方收款码，服务端校验后下发）。
- `returnUrl` 一经使用即冻结，后续请求传不同值不会改变已冻结的目标。
- `payerClientIp` 是**必填**字段：买家客户端的公网 IP，由**你的服务端转交**（填写合法公网 IPv4/IPv6，不要填内网或保留地址）。它用于风控提示，平台不会替你解析代理链；缺失或非法一律 `400`。

### 2.2 `POST /api/open/v1/payments/{outTradeNo}/attempts` — 重拉起支付尝试

| 项 | 值 |
| --- | --- |
| 成功 | `201`（新尝试）/ `200`（并发赢家投影） |
| 失败 | `400` `401` `403` `404` `409` `422` `429` `502` `503` |
| 请求体 | 无 |

要点：

- 语义是「**关旧建新**」：仅关闭处于进行中的旧尝试（状态不确定的尝试按纪律**不判死**），并创建新尝试。
- 返回的是**新材料**：`payUrl` 与 `qrCode` 同批更换，**旧码不可复用**。
- 需要新收款材料时**只用这个端点**，不要重复调用下单接口。

### 2.3 `GET /api/open/v1/payments/{outTradeNo}` — 查询订单

| 项 | 值 |
| --- | --- |
| 成功 | `200` |
| 失败 | `400` `401` `403` `404` `429` `503` |

要点：

- **本地权威读**：只读本地账本，不因查询刷量触发外部外呼，不改账、不重签收款材料。
- **`payUrl` 与 `qrCode` 恒为 `null`**：查询接口不重签材料；需要材料时走幂等重放或重拉起端点。
- 查无、跨应用、跨商家、引用畸形**统一返回中性 `404`**（这是防枚举设计，不要据此推断资源是否存在）。

### 2.4 `POST /api/open/v1/payments/{outTradeNo}/close` — 关闭订单

| 项 | 值 |
| --- | --- |
| 成功 | `200`（含 `closeState` + 订单快照） |
| 失败 | `400` `401` `403` `404` `409` `422` `429` `502` `503` |
| 请求体 | 无 |

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
| 失败 | `400` `401` `403` `404` `429` `503` |

只读本地权威退款状态，不返回内部材料与摘要。

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
| `payUrl` | 平台收银页地址（查询接口恒空） |
| `qrCode` | 官方收款码（仅下发响应、仅支付宝渠道、查询接口恒空） |
| `payUrlExpireHint` | 收款材料失效提示（UTC epoch 秒） |
| `nextAction` | 可支付但无有效尝试时引导重拉起（`CREATE_ATTEMPT`） |
| `latestAttempt` | 最近一次支付尝试的状态与到期时间（仅查询/关单投影；不含任何材料） |
| `feeProjection` | 该笔的费率投影（见 [费率与限额](./07-fees-and-limits.md)） |
| `replayed` / `unknown` | 是否幂等重放 / 状态是否不确定（**仅下单与重拉起响应**；查询/关单投影不含这两个字段） |

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

# 接口工作流（端点 / 幂等 / 状态）

> 人读版：`docs/03-api-reference.md`、`docs/02-integration-guide.md`（**不在本 Skill 包内**：Skill 包只含 `skill/**` 与 `examples/**`，需要时从门户「文档下载」包或公开仓的 `docs/` 取）。

Base URL 由平台下发（文档里写 `<BASE_URL>`），**不要硬编码 host**。

申报域名需先在门户完成**归属验证**（DNS TXT 记录名 `_xiaodou-open-api.<域名>`，或站点根目录回源文件；解析商的「主机记录」栏只填主域名之前的前缀）——步骤与常见失败见 `docs/02-integration-guide.md` §2。

## 1. 六个端点

| 端点 | 用途 | 成功 | 关键语义 |
| --- | --- | --- | --- |
| `POST /payments` | 建单 | `201` / `200`（幂等重放） | 同号同摘要重放；异摘要 `409`；下发 `payUrl` + 支付宝单的 `qrCode` |
| `POST /payments/{outTradeNo}/attempts` | 重拉起 | `201` / `200`（并发赢家） | **关旧建新**，新材料同批更换；需要新码只走这里。无请求体字段，但**必须带 `Content-Type: application/json`** |
| `GET /payments/{outTradeNo}` | 查单 | `200` | **本地权威读**；`payUrl` 与 `qrCode` **恒为 null** |
| `POST /payments/{outTradeNo}/close` | 关单 | `200` | 先与支付机构确认未支付才关。`200` 回执带 `closeState`：`CLOSE_REQUESTED`（已受理）/ `ALREADY_CLOSED`（本就已关闭）/ `UNKNOWN_KEPT`（结果不确定，**维持原状不判死**）/ `PROVIDER_PAID_CONFLICT`（关单过程中发现已支付，订单转成功）；**受理前**已判已支付 → `409`（错误体**不含** `closeState`）。两条路的正确动作相同：**先查单，不要重试关单**。无请求体字段，但**必须带 `Content-Type: application/json`** |
| `POST /refunds` | 退款 | `201` / `200`（幂等重放） | 仅已支付订单；累计退款 ≤ 实付；按**下单时冻结的收款分配快照**原路回吐——**缺快照 → `409` `OPEN_API_STATE_INVALID`**（该单不能自助退款：带 `outTradeNo`/`requestId` 走官网反馈人工处置，**不要换号重试**）；被拒 `502`；不确定 `UNKNOWN` |
| `GET /refunds/{outRefundNo}` | 退款查询 | `200` | 只读本地权威状态 |

响应信封：成功 `{requestId, ...业务字段}`；失败 `{code, message, requestId}`，**永不 2xx**。

## 2. 幂等三层（按此实现）

| 层 | 键 | 行为 |
| --- | --- | --- |
| 请求级 | `X-XD-Request-Id` | 同 (appId, 方法, 路径, requestId) 绑一次请求体摘要；重放原样返回首次响应；异体 `409` |
| 业务级 | `outTradeNo` / `outRefundNo` | 同号同内容 → `200` + `replayed=true`；异内容 → `409` |
| 状态机 | 订单/退款状态 | 非法迁移 `409` |

**实现要点**：网络超时/5xx 重试时**复用同一个 `requestId` 与同一份请求体**，但 **nonce 必须换新**（同一个 nonce 在 10 分钟内复用会拿到 `409 OPEN_API_REPLAY`，永远走不到幂等重放）；`409` 的处置是**先查单**，不是换号重下单。**幂等重放返回的是订单当前快照**：存在有效支付尝试时含 `payUrl`；尝试已终态/过期时 `payUrl` 为空并附 `nextAction=CREATE_ATTEMPT`——需要新材料就调重拉起，这不是异常。

**请求头**：六头成组；所有 `POST` 都要带 `Content-Type: application/json`（允许 charset 参数），`GET` 可省——**省掉时签名串的 `CONTENT_TYPE` 行是空行**（不是 `application/json`）；各头长度/字符集是硬约束。**请求字段约束（建单/退款逐字硬约束，违反是 `400 OPEN_API_BODY_INVALID`）**：建单必填六项——`outTradeNo` / `channel` / `amountFen` / `currency` / `subject` / `payerClientIp`（`tradeScope` 双申报应用必填）；`outTradeNo`/`outRefundNo` 6–64 位、字符集仅 `A-Z a-z 0-9 _ -`（**不能含点号**）；`amountFen` 整数分 `1`–`2000000`；`currency` 固定 `CNY`（大小写敏感）；`subject` ≤ 128、`description`/`attach`/退款 `reason` ≤ 256、`returnUrl` 绝对 `https` ≤ 512；`payerClientIp` 必须是**合法公网**地址（内网/保留段/文档示例段一律拒绝）。`channel` ∈ `ALIPAY_H5` / `WECHAT_H5`；`tradeScope` ∈ `PHYSICAL_FACE_TO_FACE` / `CARD_VIRTUAL`。**业务摘要成员**=`channel`/`tradeScope`/`amountFen`/`currency`/`subject`/`description`/`returnUrl`/`attach`（`payerClientIp` 不参与，可随重试变化）——`returnUrl` 在摘要内，改了再重试是 `409`。完整表与人读版见 `docs/03-api-reference.md` §2.7。

## 3. 状态与终态

- 订单：`CREATED` → `PAYING` → `SUCCEEDED`，或 `CLOSED` / `FAILED`；另有 `UNKNOWN`。
- 退款：`REQUESTED` → `PENDING` → `SUCCEEDED` / `FAILED`；另有 `UNKNOWN`。
- **终态只认**：查单结果，或经验签的事件。收银页打开/回跳/用户点完成**都不是**终态。
- **`UNKNOWN` 不判死**：不重新下单、不重发退款、不向买家报失败；等事件或查单收敛，长期不收敛挂「待核」队列。

## 4. 通道与申报

- `channel`：下单时冻结，不可改。
- `tradeScope`：双申报应用必填，单申报可省（取该申报形态）；不符 → `422 OPEN_API_SCOPE_CHANNEL_MISMATCH`。
- 通道链路未放行 → `422 OPEN_API_CHANNEL_UNAVAILABLE`：这是**正常拒绝**，不要重试刷量。

## 5. 交付边界（常被写错）

- 平台负责收款与支付事实；**交付（卡密/发货/开通）由商家自建系统承担**。
- 收银页在买家点「**返回商家**」时 `303` 回你冻结的 `returnUrl`——那只是导航，**不是自动跳转**。按钮由收银页本次会话**首次观察到支付成功**时提供、凭证**一次性**：买家不点、刷新过页面、或此前已点击过一次时都不会（再）回跳；**扫码支付（手机付款、PC 收银页轮询）不受此限**，照常提供。凭证有效期 = 支付窗口（默认 600 秒，平台侧可调）+ 终态展示宽限 600 秒；超时后点击看到的是**中性提示页**（不是报错 JSON）——按「非终态」处理即可。`returnUrl` 落地页只做展示与轮询自己的服务端，**不要把交付内容放进 query**。
- **微信内（JSAPI）**：完成时微信接管完成页（收银页关闭）；买家经**微信支付记录中的「商家小票」**点「返回商家」回到同一个 `returnUrl`（平台侧配置，无需商家开通；同属导航，非终态）。

## 6. 最小可用骨架（伪代码）

```text
createOrder():
  requestId = uuid()                      # 与本次请求体绑定，重试复用
  resp = POST /payments (六头签名, outTradeNo)
  if resp.status in (200, 201): return resp.snapshot
  if resp.code == OPEN_API_IDEMPOTENCY_CONFLICT: return queryOrder(outTradeNo)   # 先查单
  else: raise

queryOrder(outTradeNo):
  return GET /payments/{outTradeNo}        # payUrl/qrCode 恒空，正常

reopen(outTradeNo):
  return POST /payments/{outTradeNo}/attempts   # 只有这里能拿新码

onEvent(payload):                          # 见 webhook-verification.md
  if seen(payload.eventId): return success
  apply(payload)                           # 订单/退款状态迁移 + 交付动作
  markSeen(payload.eventId); return success
```

## 7. 最小建单体（可直接改）

请求（六头成组，签名见 `signature-spec.md`；`<BASE_URL>` 在门户「应用凭证」页复制）：

```http
POST <BASE_URL>/payments
X-XD-App-Id / X-XD-Timestamp / X-XD-Nonce / X-XD-Key-Id / X-XD-Request-Id / X-XD-Sign
Content-Type: application/json
```

```json
{
  "outTradeNo": "SHOP20261010A0001",
  "channel": "ALIPAY_H5",
  "tradeScope": "PHYSICAL_FACE_TO_FACE",
  "amountFen": 1000,
  "currency": "CNY",
  "subject": "示例商品",
  "payerClientIp": "<买家公网 IP（内网/保留段/文档示例段会被拒），仅作风控提示>"
}
```

- 必填六项缺一或越界 → `400 OPEN_API_BODY_INVALID`；`tradeScope` 只在双申报应用必填（单申报可省）。
- 成功 `201`（幂等重放 `200`）→ 响应含订单快照与 `payUrl`（支付宝单可能另有 `qrCode`）；收款页形态见 `terminal-matrix.md`。

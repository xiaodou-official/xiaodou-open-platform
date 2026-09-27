# 快速开始（5 分钟跑通首单）

> docId：`XD-OP-01` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

本篇只做一件事：让你的服务端成功创建一个支付订单、把收款材料交给买家、并收到支付终态。字段级细节见 [API 参考](./03-api-reference.md)，报错见 [错误码与排障](./04-errors-and-troubleshooting.md)。

## 0. 前置条件

| 项 | 说明 |
| --- | --- |
| `appId` | 应用标识，开通后在门户「应用凭证」页可见 |
| `keyId`（`kid`） | 签名密钥标识，与你的 RSA2 公钥成对 |
| RSA2 私钥 | **只在你自己的服务器上生成与保存**，私钥永不上传、永不进浏览器 |
| Base URL | 平台在开通时提供。文档与示例中一律写作 `<BASE_URL>`，不要从本资料里抄任何 host |
| 出口 IP | 你的服务器出口 IP 需在门户的 IP 白名单内（未加白名单的请求会被拒） |
| 申报域名归属 | 申报的每个网站域名需先在门户完成归属验证（DNS TXT 或回源文件二选一）；做法见 [接入指南 · 域名归属验证](./02-integration-guide.md#2-域名归属验证申请开通前完成) |
| 平台公钥 | 验平台响应/事件签名用；取自 [接入指南 · 平台公钥与指纹](./02-integration-guide.md#31-平台公钥与指纹公示)（与门户同源） |

## 1. 生成一次请求签名（六头）

每个请求都要带六个头：`X-XD-App-Id`、`X-XD-Timestamp`、`X-XD-Nonce`、`X-XD-Key-Id`、`X-XD-Request-Id`、`X-XD-Sign`。
签名算法是 **RSA-SHA256**，签名覆盖一段固定格式的**规范串**（含请求体原始字节的 SHA-256）。

直接复制对应语言的示例：

- Node.js：[`examples/node/sign.js`](../examples/node/sign.js)
- Java：[`examples/java/XdSignature.java`](../examples/java/XdSignature.java)
- PHP：[`examples/php/xd_signature.php`](../examples/php/xd_signature.php)
- Python：[`examples/python/xd_signature.py`](../examples/python/xd_signature.py)

规范串构成与逐字段约束见 [安全红线 · 请求签名](./09-security-redlines.md)。

## 2. 创建订单

```http
POST <BASE_URL>/api/open/v1/payments
Content-Type: application/json
X-XD-App-Id: xdop_xxxxxxxxxxxxxxxx
X-XD-Timestamp: 1758888888
X-XD-Nonce: 6f1c2f7a9d0b4e51
X-XD-Key-Id: kid_20260926
X-XD-Request-Id: 018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55
X-XD-Sign: <Base64 签名值>

{
  "outTradeNo": "SHOP20260926A0001",
  "channel": "ALIPAY_H5",
  "amountFen": 100,
  "currency": "CNY",
  "subject": "示例商品",
  "payerClientIp": "203.0.113.10"
}
```

> 上面这单里有**六个必填字段**：`outTradeNo`、`channel`、`amountFen`、`currency`、`subject`、`payerClientIp`（买家公网 IP，由你的服务端转交）。少一个即 `400`；请求体是**严格模式**，多传 schema 之外的字段同样 `400`。

> **⚠️ 示例里的两个值只能看，不能照抄：**
> - `X-XD-Timestamp: 1758888888` 是**规范串自检用的固定值**。真实请求必须带**当前时间**（秒级 epoch，时间窗 **±300 秒**），照抄这个过去的时间戳会被 `401` 拒。
> - `payerClientIp: 203.0.113.10` 是 RFC 5737 **文档示例网段**，属于服务端**明确拒绝**的保留段（连同 `10/8`、`172.16/12`、`192.168/16`、`127/8`、CGNAT 等一并拒绝）——照抄会得到 `400 OPEN_API_BODY_INVALID`。这里必须填**买家的真实公网 IP**（由你的服务端转交）。

成功返回 `201`（业务幂等重放返回 `200`）：

```json
{
  "requestId": "018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55",
  "openOrderId": "op_01J8ZQ7K3M5N6P7Q8R9S0T1U2V",
  "outTradeNo": "SHOP20260926A0001",
  "status": "CREATED",
  "channel": "ALIPAY_H5",
  "tradeScope": "CARD_VIRTUAL",
  "links": ["ALIPAY_AGGREGATION_NATIVE"],
  "amountFen": 100,
  "currency": "CNY",
  "expireAt": "2026-09-26T12:34:56.000Z",
  "payUrl": "https://<平台收银页地址>/cashier/<token>",
  "qrCode": "https://qr.alipay.com/bax0example000000000000",
  "payUrlExpireHint": 1758889488,
  "feeProjection": {
    "ruleVersion": "<生效配置版本>",
    "tier": "STANDARD",
    "merchantRateBps": 0,
    "companyServiceFeeRateBps": 0,
    "merchantSettlementFen": 0,
    "companyServiceFeeFen": 0
  }
}
```

> 上例中的 `feeProjection` 数值已抹零占位——**费率与金额一律以上线时该字段的实际返回为准**，本资料不写死任何费率或限额数字。

三个关键字段：

- **`payUrl`**：平台收银页地址（买家可打开的收款页）。
- **`qrCode`**：**官方收款码**。仅支付宝渠道、且服务端校验为官方前缀时才下发；商家可在**自有 PC 页面**直接渲染成二维码，与平台收银页同形。**只在下发响应有效**，查询接口恒为 `null`。
- **`expireAt`**：订单支付窗口截止时间，以服务端下发为准。

## 3. 把收款材料交给买家

三种标准用法（终端语义与红线见 [收银页对接与终端能力矩阵](./06-cashier-integration.md)）：

| 用法 | 怎么做 | 适用 |
| --- | --- | --- |
| 自渲染官方收款码 | 取响应中的 `qrCode`，在自有 PC 页面渲染二维码 | 桌面买家扫码 |
| 渲染收银页二维码 | 把 `payUrl` 渲染成二维码，买家手机扫码进平台收银页 | 桌面→手机 |
| 302 跳转收银页 | 把买家浏览器 `302` 到 `payUrl` | 手机买家直接进入 |

> `qrCode` 与 `payUrl` 都由服务端下发，**不要在客户端拼接、改写或转发到第三方**；渲染前做一次前缀防呆复检。

## 4. 拿支付终态

**收银页打开、收银页回跳、用户点击完成都不是支付终态。** 终态只有两条来源：

1. **事件通知**（推荐）：在你的应用里配置 `notifyUrl`，平台会把 `PAYMENT_SUCCEEDED` 等事件推给你的服务器，用平台公钥验签后按 `eventId` 去重落账 —— 见 [webhook 验签](./05-webhook-verification.md)。
2. **主动查单**：`GET <BASE_URL>/api/open/v1/payments/{outTradeNo}`（本地权威读，零外部外呼）。

两条路径都要接：事件是主路径，查单是对账与补偿路径。

## 5. 退款与对账

- 退款：`POST <BASE_URL>/api/open/v1/refunds`（`outRefundNo` 业务幂等），见 [退款与对账](./08-refund-and-reconciliation.md)。
- 费率与结算口径**不写死在代码里**：每笔订单响应里的 `feeProjection` 就是该笔的生效口径，见 [费率与限额](./07-fees-and-limits.md)。

## 6. 本地先跑一遍

`demo/h5-cashier/` 是一个**零外部依赖**的本地 demo（loopback + mock），把下单、收银页三端形态、轮询、事件验签、查单、退款整条链跑通，不需要任何生产凭证：

```bash
node demo/h5-cashier/server.js
# 浏览器打开终端提示的本地地址
```

## 7. 首单常见失败

| 现象 | 先看 |
| --- | --- |
| `401` 验签失败 | 规范串与六头形态：是不是把 query 排序、原始 body 字节、`Content-Type` 规范化写错了 |
| `403` 来源 IP 判定失败 | 出口 IP 是否在白名单内；请求是否绕过了你配置的代理 |
| `400` 请求体非法 | 是否存在 schema 之外的字段（请求体是**严格模式**，未知字段直接拒） |
| `413` 请求体过大 | 请求体有流式硬上限，超大 `attach`/`description` 会被拒 |
| `422` 通道不可用 | 该通道的链路尚未放行，或申报范围（`tradeScope`）与通道不符 |

完整错误码与决策树见 [错误码与排障](./04-errors-and-troubleshooting.md)。

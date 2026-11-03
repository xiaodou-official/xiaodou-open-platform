# 微信 JSAPI 公众号配置（商户自有收银台）

> 人读版：`docs/15-wechat-jsapi-setup.md`（**不在本 Skill 包内**：Skill 包只含 `skill/**` 与 `examples/**`，需要时从门户「开发者文档」页的「下载文档包」或公开仓的 `docs/` 取）。

这篇只解决一件事：**新渠道商户收微信时，公众号怎么配、appid 怎么绑、页面怎么拉起**。
平台只登记与读回，**不代做微信侧配置**。

## 1. 适用判断

```text
买家在哪付款？
├─  merchants 自己的页面 / 公众号内 → 需要本篇配置（微信 JSAPI）
├─ 平台收银页 → 商户单微信不可用；改用支付宝，或把买家引导到自有收银页
└─ 只收支付宝 → 不需要公众号 appid，也不需要授权目录
```

铁律：

- **平台服务号/平台公众号的 appid 永不能用于商户单**；一条微信支付配置只对应一个公众号 appid。
- 支付宝没有逐商户 appid，与微信 JSAPI 是同一个建单接口的两个 `channel`，不要为支付宝配公众号。
- 微信支付只能在微信内调起；微信外手机浏览器与自有 App 内没有直接拉起形态。

## 2. 前置条件（逐项打勾）

- [ ] 已通过微信认证的**服务号**（订阅号没有网页授权能力）。
- [ ] 公众号已具备微信支付能力；商户号已完成实名与微信渠道开通。
- [ ] 已 ICP 备案的 **HTTPS** 域名（收银页与 OAuth 回跳都在它下面）。
- [ ] 服务端能安全保存公众号 `AppSecret`，能完成网页授权换取 `openid`。
- [ ] 微信支付商户平台可登录并配置支付授权目录；由服务商代管时联系对接人协助。

## 3. 微信侧配置

### 3.1 网页授权域名（公众号后台）

- 路径：公众号后台 → 设置与开发 → 公众号设置 → 功能设置 → **网页授权域名**。
- 填纯域名（不带 `https://`、不带路径），按微信要求上传校验文件到域名根目录。
- OAuth 的 `redirect_uri` 必须落在这个域名下。
- 只调起支付不需要 JS-SDK；另外使用 JS-SDK（分享、拍照等）才需要 **JS 接口安全域名**。

### 3.2 JSAPI 支付授权目录（微信支付商户平台）

- 路径：微信支付商户平台 → 产品中心 → 开发配置 → **支付授权目录**（名称以微信后台为准）。
- 必须 HTTPS，最多 **5 个**；目录与页面逐级匹配（多一层、少一层都不行）。
- 必须覆盖**发起支付的那个页面**。
- **不在平台 API 配置范围内**：平台只登记与读回，不能代改。

### 3.3 appid 归属

- 形如 `wx` + 16 位十六进制；
- 必须是商户自己的公众号，并绑定到商户自己的商户号；
- 绑定动作在平台侧完成（下一节），不要在微信侧重复绑定。

## 4. 平台侧绑定

路径：**商家后台 → 商户收银台**。

| 字段 | 值 |
| --- | --- |
| 公众号 appid | 商户自己的公众号 appid |
| 支付授权域名 | 收银页所在域名（纯域名） |
| 网页授权域名 | 公众号后台配置的网页授权域名；与支付域名相同可留空 |
| JSAPI 支付授权目录 | 与微信支付商户平台逐字一致；每行一个，`https://` 开头，最多 5 个 |
| 首次绑定联系人 | 姓名 / 手机号 / 邮箱（渠道备案，不展示给买家） |

提交后**以渠道读回为准**：页面显示「appid 已绑定」才算可用。未确认前建单返回：

| 面 | HTTP | code / reason |
| --- | --- | --- |
| 开放平台 | `403` | `OPEN_API_MERCHANT_APPID_UNAVAILABLE` |
| 开放平台（appid 不一致/平台 appid） | `422` | `OPEN_API_MERCHANT_APPID_INVALID` |
| 商户 API | `403` | `MARKET_SELLER_API_FORBIDDEN`，`details.reason=APPID_NOT_BOUND` |
| 商户 API（appid 不一致） | `422` | `MARKET_SELLER_API_INVALID_ARGUMENT`，`details.reason=APPID_MISMATCH` |

## 5. 服务端流程

### 5.1 取 openid

```text
https://open.weixin.qq.com/connect/oauth2/authorize
  ?appid=<商户公众号 appid>
  &redirect_uri=<URL 编码的回跳地址，必须在网页授权域名下>
  &response_type=code
  &scope=snsapi_base
  &state=<防重放随机串>
#wechat_redirect
```

用 `code` 换 `access_token` 与 `openid`。**openid 是公众号维度的**：必须是当前 appid 下的 openid。

### 5.2 建单

```text
开放平台：POST /api/open/v1/payments
  { outTradeNo, channel, amountFen, subject, payerClientIp,
    subOpenid, subAppid?, notifyUrl, returnUrl? }

商户 API：POST /api/merchant/v1/payments
  { merchantOrderNo, channel: "WECHAT", amountFen, subject,
    subOpenid, notifyUrl, returnUrl? }
```

- `subOpenid` 微信单必填，**不落库**；同一单重新拉起必须重新提交。
- `subAppid` 可选；传了必须与已绑定 appid 逐字一致。
- 支付宝单不得携带 `subOpenid/subAppid`。

### 5.3 拉起

```js
function onBridgeReady() {
  WeixinJSBridge.invoke('getBrandWCPayRequest', jsapiParams, function (res) {
    // res.err_msg 只是前端回调，不是支付终态
  });
}
if (typeof WeixinJSBridge === 'undefined') {
  document.addEventListener('WeixinJSBridgeReady', onBridgeReady, false);
} else {
  onBridgeReady();
}
```

`jsapiParams` = `{ appId, timeStamp, nonceStr, package, signType, paySign }`，来自建单/重拉起响应。

**支付终态只认查单或验签通知**：`getBrandWCPayRequest` 回调、页面跳转、「已完成支付」都不算。

## 6. 失败谱

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `redirect_uri` 参数错误 | 网页授权域名未配置或回跳不在该域名下 | 公众号后台补配；回跳改到该域名 |
| 「当前页面的URL未注册」 | 授权目录未覆盖当前页面 | 微信支付商户平台补目录；核对层级 |
| appid 与 openid 不匹配 | openid 属于别的公众号 | 用同一个 appid 重新授权 |
| `APPID_NOT_BOUND` / `OPEN_API_MERCHANT_APPID_UNAVAILABLE` | 平台未绑定或读回未确认 | 商户收银台提交并等读回 |
| `APPID_MISMATCH` / `OPEN_API_MERCHANT_APPID_INVALID` | 平台 appid 或与绑定值不一致 | 改成商户自己的 appid |
| 微信外打不开支付 | 微信支付只能在微信内调起 | 引导微信内打开或改走支付宝 |

## 7. 边界

- 平台不代做公众号认证、网页授权域名与支付授权目录配置；只登记与读回。
- 平台服务号 appid 永不用于商户单。
- 微信内不能直接拉起支付宝。
- 公众号与商户号的关联/授权是否需要在微信侧再确认，以微信后台提示为准；绑定结果以平台读回为准。
- 本篇不改变平台收银页行为；平台收银页商户单的微信仍不可用。

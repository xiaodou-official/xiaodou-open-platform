# 到账账号与收款分配（查询接口）

> docId：`XD-OP-14` ｜ version：`1.0.0` ｜ status：`PUBLISHED`

这一篇给**需要在自己后台看清「钱进了哪个账户、按什么规则分配」**的商家。收款账户的**设置**在商家后台完成；商家 API 侧只提供一个**只读查询**接口，用它把「有哪些到账账号、当前怎么分」展示到你自己的系统里。

## 1. 先理解三件事

| 名词 | 含义 |
| --- | --- |
| **到账账号** | 一份实名主体＋一个银行账户的组合。一个商家可以绑定**多个**到账账号（例如几家门店、几家不同主体的公司各一个账户） |
| **参与收款** | 你从已绑定的到账账号里，勾选一组「参与收款」的账号——只有它们会参与收款分配 |
| **收款方式** | 这组账号怎么分这笔钱：**全部进一个账号**（单账号）、**按顺序轮流**（轮询）或**按比例分账**（比例分账，2–4 个参与账号） |

每个到账账号最多绑定一个银行账户；同一张银行卡不能绑到两个到账账号上。账号的绑定与增补走的是**进件（实名审核）主链**，审核通过后才会出现在列表里。

## 2. 查询接口

### `GET /api/open/v1/settlement/accounts`

| 项 | 值 |
| --- | --- |
| 成功 | `200` |
| 失败 | `400` `401` `403` `429` `503` |
| 请求体 | 无 |
| 幂等面 | 无（只读，不改任何状态） |

**示例响应**（`200`）：

```json
{
  "requestId": "req_你的请求号",
  "sellerType": "INDIVIDUAL_BUSINESS",
  "accounts": [
    {
      "applicationId": "APP-…",
      "subjectName": "某某小吃店",
      "merchantId": "商户号",
      "bankName": "某某银行",
      "cardLast4": "8888",
      "state": "ACTIVE",
      "eligible": true,
      "inPool": true,
      "isPrimary": true
    }
  ],
  "routing": {
    "enabled": true,
    "mode": "ROUND_ROBIN",
    "order": ["APP-…", "APP-…"],
    "activeApplicationId": null,
    "ratios": null,
    "unavailablePolicy": "REJECT",
    "revision": 3,
    "updatedAt": "2026-10-14T02:00:00.000Z"
  },
  "limits": { "maxPoolSize": 4 }
}
```

**比例分账示例（`200`，节选）**：

```json
{
  "routing": {
    "enabled": true,
    "mode": "RATIO",
    "order": ["APP-…A", "APP-…B"],
    "activeApplicationId": null,
    "ratios": [
      { "applicationId": "APP-…A", "shareBps": 6000 },
      { "applicationId": "APP-…B", "shareBps": 4000 }
    ],
    "unavailablePolicy": "REJECT",
    "revision": 4,
    "updatedAt": "2026-10-17T02:00:00.000Z"
  }
}
```

> `ratios` 是**配置面快照**（你保存的设置），不是每一单的实时重算结果。实际生效腿按每单可用账号与 `unavailablePolicy` 决定：`REJECT`（默认）整单拒绝；`RENORMALIZE` 按剩余账号重新归一（极端情况下生效腿可只剩 1 条、达到 10000bps），该单快照会记录归一化结果。

响应字段：

| 字段 | 含义 |
| --- | --- |
| `sellerType` | 你的主体类型（`COMPANY` / `INDIVIDUAL_BUSINESS` / `PERSONAL`） |
| `accounts[].applicationId` | 到账账号的标识。**用它和 `routing.order` 里的值对齐**，不要当成银行卡号 |
| `accounts[].subjectName` | 主体名称（企业为营业执照名称；个人为展示用名） |
| `accounts[].merchantId` | 商户号（收款账户的对外编号；未开通时为 `null`） |
| `accounts[].bankName` / `cardLast4` | 银行名称与**银行卡尾号 4 位**（完整卡号不通过任何接口对外，见第 4 节） |
| `accounts[].state` | `ACTIVE`（可收） / `PENDING`（审核或开通中） / `INACTIVE`（已失效） |
| `accounts[].eligible` | 当前是否**可被收款命中**（审核完备、状态正常才是 `true`） |
| `accounts[].inPool` | 是否在你当前的「参与收款」集合里 |
| `accounts[].isPrimary` | 是否主账号（承载经营资格的账号） |
| `routing.enabled` | 收款分配功能是否已开通生效 |
| `routing.mode` | `SINGLE`＝全部进一个账号；`ROUND_ROBIN`＝按 `order` 顺序轮流；`RATIO`＝按 `ratios` 比例分账 |
| `routing.order` | 参与收款的账号（勾选顺序＝轮询顺序；比例分账时与 `ratios` 同集合） |
| `routing.activeApplicationId` | 单账号方式的收款目标（`null` 表示按 `order` 的第一个） |
| `routing.ratios` | 比例分账的**配置面明细**：`{ applicationId, shareBps }[]`；参与账号 2–4 个，每项 `0 < shareBps < 10000`，合计恒为 `10000`bps；非 `RATIO` 方式为 `null` |
| `routing.unavailablePolicy` | 参与账号暂时不可用时的策略：`REJECT`＝整单拒绝（默认）；`RENORMALIZE`＝按剩余账号继续 |
| `routing.revision` / `updatedAt` | 收款设置的版本号与最近保存时间 |
| `limits.maxPoolSize` | 「参与收款」账号数上限 |

## 3. 分配的边界（重要）

- **一单一结、随单冻结**：一笔订单在**创建时**就确定了它走哪个账号，之后不再改变。修改收款方式**只影响之后新建的订单**——已创建（包括未支付）的订单仍按创建当时的分配执行。
- **不可用即跳过，绝不静默改道**：某个参与账号暂时不可用时，轮询会跳过它；如果目标账号都不可用，订单会被**拒绝**，而不是悄悄换一个账户收——不会出现「钱进了你没预期的账户」。
- **退款按原订单快照发起回退**：退款按**原订单**创建时冻结的收款分配快照回退，与当前设置无关；实际到账路径以支付服务方原交易与分账合同为准。

## 4. 关于卡号与商户号

- 查询接口（以及所有对外接口）**只返回银行卡尾号 4 位**，完整卡号不对外下发。
- 商户号与主体名称按账号明文展示——这是给你**在自有后台做对账与展示**用的。
- 这一类信息属于你的**账户隐私**：不要拼进买家可见的页面，也不要写进日志或截图里外发。

## 5. 设置在哪里做

收款方式（哪些账号参与、顺序、单账号目标、不可用时的策略）的**唯一设置入口是商家后台**的「店铺设置 → 到账账号」页；每次保存会生成新的设置版本（响应里的 `revision`），并在页面上明确提示「**从下一笔新订单开始生效，此前订单不变**」。

商家 API **不提供**任何修改收款方式的接口——这是有意为之：资金去向的变更应当有人在后台确认。用本篇的查询接口把结果同步到你的系统即可。

## 6. 常见问题

**「比例分账」怎么设置、怎么算？**
在商家后台「店铺设置 → 到账账号」选择比例分账并填写各账号比例即可：参与账号 2–4 个，配置面每项 `shareBps` 满足 `0 < shareBps < 10000`，合计恒为 10000bps；保存后从下一笔新订单生效。查询接口返回配置面的 `ratios` 快照；单笔实际生效腿由该单可用账号与 `unavailablePolicy` 决定（`REJECT` 整单拒绝；`RENORMALIZE` 按剩余账号归一）。

**为什么某个账号的 `eligible` 是 `false`？**
该账号的实名审核、业务开通或账户状态还没完备（或已失效）。它仍会出现在列表里（方便你解释「为什么这笔没进这个账户」），但不会被收款命中。

**轮询是「按金额」还是「按笔数」？**
按**订单**轮流：每新建一笔订单消耗一个位置，与金额无关。未支付的订单同样占位。

**我可以让某一笔订单指定收款账号吗？**
不可以。分配规则在后台统一设置、对全部新订单生效；下单接口不接受「本单收款账号」参数。

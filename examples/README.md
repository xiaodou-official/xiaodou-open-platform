# 四语言请求签名示例

> 四份实现（Node.js / Java / PHP / Python）按同一套规则产出**完全相同**的规范串与签名。任选其一，或对照着移植到你自己的语言。
> **一处已知差异**：路径里出现 `+` 时，Python/Java 两份示例按表单语义把它当空格，平台与 Node/PHP 保留原样。当前接口的路径变量只允许 `A-Za-z0-9_-`，**不会出现 `+`**；若你自行放宽路径字符集，请以平台行为（保留 `+`）为准。

| 语言 | 文件 | 依赖 |
| --- | --- | --- |
| Node.js | [`node/sign.js`](./node/sign.js) | 无（Node 内置 `crypto`） |
| Java | [`java/XdSignature.java`](./java/XdSignature.java) | JDK 17+（仅标准库） |
| PHP | [`php/xd_signature.php`](./php/xd_signature.php) | PHP 8+（`openssl` / `hash`） |
| Python | [`python/xd_signature.py`](./python/xd_signature.py) | `cryptography` |

事件验签参考实现：[`node/verify_webhook.js`](./node/verify_webhook.js)；
响应验签参考实现：[`node/verify_response.js`](./node/verify_response.js)（自检 `--golden` 不需要密钥）。

## 1. golden 向量（不依赖密钥的自检）

用下面这组**固定输入**，任何人都能算出唯一的规范串——这是最快的自检：**先对规范串，再谈签名**。

| 输入 | 值 |
| --- | --- |
| 方法 | `POST` |
| 地址（含 query，故意乱序） | `/api/open/v1/payments?b=2&a=1` |
| `timestamp` | `1758888888` |
| `nonce` | `6f1c2f7a9d0b4e51` |
| `appId` | `xdop_example000000000` |
| `keyId` | `kid_example` |
| `requestId` | `018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55` |
| `Content-Type`（故意带参数与大写） | `application/json; charset=utf-8` |
| 请求体（原始字节，无尾随换行） | `{"outTradeNo":"SHOP20260926A0001"}` |

**期望规范串（11 行，逐字节一致）**：

```text
XD-Signature-v1
POST
/api/open/v1/payments
a=1&b=2
1758888888
6f1c2f7a9d0b4e51
xdop_example000000000
kid_example
018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55
application/json
954802c8e1bc119a1927d07af5c27d7c29c6d9467d8e93ccf83ebca8ef0252c7
```

校验命令（Node 示例，自己算一遍比对）：

```bash
node -e '
// 在 open-platform/ 的**上一级目录**（仓库根）执行：
const s = require("./open-platform/examples/node/sign.js");
const { path, query } = s.splitUrl("/api/open/v1/payments?b=2&a=1");
console.log(s.buildSigningString({
  method: "POST", path, query,
  timestamp: 1758888888, nonce: "6f1c2f7a9d0b4e51",
  appId: "xdop_example000000000", keyId: "kid_example",
  requestId: "018f2c1e-8b21-7c3a-9f10-2b7c9a1d4e55",
  contentType: "application/json; charset=utf-8",
  rawBody: "{\"outTradeNo\":\"SHOP20260926A0001\"}",
}));'
```

这组输入钉住三个最容易写错的地方：**query 键名排序**（`b=2&a=1` → `a=1&b=2`）、**`Content-Type` 归一化**（去参数并小写）、**body 哈希取原始字节**。

**空 query 的分支另外自检**（生产上六个端点**全部**没有 query——空行是每个真实请求都会走到的分支，上面这组非空 query 钉不到它）：把地址换成不带 `?` 的 `/api/open/v1/payments`，规范串第 4 行应为**空行**（即第 3 行后紧跟一个 `\n`，然后直接是时间戳行）。

> 签名值本身与密钥相关，因此不在本文件给出。请用你自己的私钥签名、再用对应公钥验签自证（示例均可本地跑通）。

## 2. 运行

```bash
# Node.js
XD_APP_ID=xdop_xxx XD_KEY_ID=kid_xxx XD_PRIVATE_KEY_PATH=./private_key.pem \
  node node/sign.js POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'

# Java
javac java/XdSignature.java
XD_APP_ID=xdop_xxx XD_KEY_ID=kid_xxx XD_PRIVATE_KEY_PATH=./private_key.pem \
  java -cp java XdSignature POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'

# PHP
XD_APP_ID=xdop_xxx XD_KEY_ID=kid_xxx XD_PRIVATE_KEY_PATH=./private_key.pem \
  php php/xd_signature.php POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'

# Python
pip install cryptography
XD_APP_ID=xdop_xxx XD_KEY_ID=kid_xxx XD_PRIVATE_KEY_PATH=./private_key.pem \
  python3 python/xd_signature.py POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'
```

命令行模式**只做本地自检，不发起任何网络请求**；私钥仅在本机内存中使用。

## 3. 四份实现的共同约束（改代码前先读）

- **路径**：URL 解码**恰好一次**；拒绝 `..`、重复斜杠、反斜杠与控制字符——编码差异**不会**被平台归一。
- **查询串**：逐键值解码一次 → RFC3986 重编码 → **按键名排序**（重复键保留原相对顺序）；**无 query 时该行为空行**。
- **`Content-Type`**：小写、去掉 `;` 参数；**没带这个头时该行为空行**（`GET` 且无请求体就是这种情况）——写成 `application/json` 会得到中性 `401`，这是最容易踩的一个自检盲区。
- **请求体哈希**：对**真正发出去的原始字节**做 SHA-256（不是解析后再序列化的结果）。
- **重试**：必须复用同一个 `requestId` 与**逐字节相同**的请求体（注意「不传 body」与「传 `{}`」不是同一份）、**同时换一个新 nonce**（同一个 nonce 在 10 分钟内复用会被判重放、返回 `409 OPEN_API_REPLAY`，走不到幂等重放），否则会变成新请求。业务摘要成员见 [API 参考 §2.7](../docs/03-api-reference.md)——`returnUrl` 在摘要内，改了再重试是 `409`。
- **错误处理**：失败响应永不 2xx；判错只认响应里的 `code`（见 [错误码与排障](../docs/04-errors-and-troubleshooting.md)）。
- **`409` 的正确动作是查单**，不是换单号重下单。

## 4. 覆盖的调用场景

示例覆盖：下单、重拉起支付尝试、查单、关单、退款、事件验签与 `eventId` 去重。**未示范**：退款查询（接口本身可用，demo 未接入口）、`UNKNOWN` 状态的补偿查证（demo 不产生该状态），响应验签由 [`node/verify_response.js`](./node/verify_response.js) 覆盖（四头齐备才验；缺头按未签名响应处理）。

**不示范**的两件事（都是错的）：绕过幂等重复下单、把收银页回跳当支付终态。

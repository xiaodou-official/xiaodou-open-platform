# Skill 内示例索引

本目录**不复制**示例代码，只做索引——四语言参考实现与本仓 demo 是全包唯一副本，避免出现第二份会漂移的源。

| 资产 | 路径 | 用途 |
| --- | --- | --- |
| Node.js 请求签名 | [`../../examples/node/sign.js`](../../examples/node/sign.js) | 规范串 + 六头签名（零依赖） |
| Node.js 事件验签 | [`../../examples/node/verify_webhook.js`](../../examples/node/verify_webhook.js) | `XD-Webhook-v1` 验签 + `eventId` 去重骨架 |
| Node.js 响应验签 | [`../../examples/node/verify_response.js`](../../examples/node/verify_response.js) | `XD-Response-v1` 验签（四头齐备才验；`--golden` 自检不需要密钥） |
| Java 请求签名 | [`../../examples/java/XdSignature.java`](../../examples/java/XdSignature.java) | JDK 17+ 标准库 |
| PHP 请求签名 | [`../../examples/php/xd_signature.php`](../../examples/php/xd_signature.php) | PHP 8+ openssl |
| Python 请求签名 | [`../../examples/python/xd_signature.py`](../../examples/python/xd_signature.py) | `cryptography` |
| golden 向量 | [`../../examples/README.md`](../../examples/README.md) | 不依赖密钥的规范串自检 |
| 本地收银 demo | `demo/h5-cashier/`（**不在 Skill 包内**，用公开仓全量目录） | 全链可跑 + 冒烟脚本 |

## 最小落地顺序（给 AI 编码助手）

1. 用 `examples/` 里对应语言的文件生成签名，先让 **golden 向量**逐字节对上。
2. 按 [`../references/api-workflow.md`](../references/api-workflow.md) 实现「建单 → 重拉起 → 查单」与幂等三层。
3. 按 [`../references/terminal-matrix.md`](../references/terminal-matrix.md) 决定收款页形态（不要把终端分派写在商家侧）。
4. 按 [`../references/webhook-verification.md`](../references/webhook-verification.md) 接事件（原始字节验签 + `eventId` 去重 + 回 `success`）。
5. 起 `demo/h5-cashier/server.js` 与 `smoke.js` 自证；上线前逐条过 [`../references/go-live-checklist.md`](../references/go-live-checklist.md)。

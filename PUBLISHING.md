# 公开发布参数

> 本文件记录这份资料**公开发布所依据的参数与流程**，随资料一同公开——便于读者确认「你看到的这份内容是怎么发布出来的」。
> 文件底部的机器可读块是发布判据的**唯一来源**，由仓库门禁 `scripts/open_platform_docs_gate.sh` 逐字校验（含负向变异验证）：**改状态必须同批改说明**。

## 1. 五项发布参数

| # | 参数 | 状态 | 内容 |
| --- | --- | --- | --- |
| 1 | 文件夹名 | 已定 | `open-platform`（改名须同批改门禁：README 索引、门禁的目录常量与路径表述） |
| 2 | 独立仓与归属 | 已定 | GitHub 组织 `xiaodou-official` × 仓 slug `xiaodou-open-platform`。组织与许可主体同属一个运营主体，故 `LICENSE` / `LICENSE-CODE` 的署名主体不因归属而改变 |
| 3 | 可见范围 | 已定 | 公开仓 |
| 4 | 许可证 | 已定 | 内容 = CC BY 4.0（[`LICENSE`](./LICENSE)）；示例代码 = MIT（[`LICENSE-CODE`](./LICENSE-CODE)） |
| 5 | 发布方式与差异清单签收 | 已定 | 发布方式 = **单树快照**（`git commit-tree HEAD:open-platform`，单一内容源、无二次拷贝）。**不使用** `git subtree split`：本仓历史体量大，实测重放远超快照耗时，而本目录无历史需要携带，两者产出同一内容树。差异清单（公开版 vs 登录后视图）签收人：`luwulei` |

## 2. 两条通道，同源同 hash

- 本目录是这份资料的**唯一内容源**：① 公开通道 = 发布为独立公开仓；② 登录后通道 = 门户内的文档与 Skill 下载。两条通道**同源同 hash**。
- **商户专属内容只进登录后视图**：`appId`、凭证指纹、生效费率与限额等商户专属内容**不写在这份文件里**，由门户在渲染时注入。因此公开版与登录后版的**文件集差集为空**——登录后视图是公开版的严格子集。
- 公开版必须**单独**跑脱敏与禁词扫描，不得只扫登录后版。

## 3. 发布前检查（执行顺序）

1. `bash scripts/open_platform_docs_gate.sh --release-check` 全绿（结构 / 脱敏 / 禁词 / 数字禁令 / 同源断言 / 内容 hash / 发布参数）。
2. 确认第 1 节五项均为「已定」，且底部机器可读块 `publicRepoPushAuthorized=true`。
3. `LICENSE` / `LICENSE-CODE` 就位，且与第 1 节第 4 项逐字一致。
4. 待推 commit 与内容清单先经只读 dry-run 打印（**不联网**）：`bash scripts/open_platform_public_release_dry_run.sh`。
5. 差异清单（公开版 vs 登录后视图）由第 1 节第 5 项的签收人过目。
6. **推送后**才回填 `MANIFEST.json` 的 `releases[0].publishedAt` 与 `channels.publicRelease.status`，并重算 hash：`bash scripts/open_platform_docs_gate.sh --write`。
   - 这两项在真正推送之前保持空值与「待投递」：把「已发布」写在未发布的状态上，是这份资料里最不该出现的一类错误。
7. 三方版本一致读回：发布 tag ↔ `MANIFEST.json` 的 `skillVersion` ↔ 门户下载包 `contentHash`。

## 4. 机器可读块（发布判据；改状态必须同批改说明）

<!-- xd-publishing-parameters -->
```json
{
  "schema": "xd-open-platform-publishing-parameters/v1",
  "items": [
    { "id": 1, "key": "folderName", "status": "DECIDED", "currentValue": "open-platform" },
    { "id": 2, "key": "repoSlugAndOwner", "status": "DECIDED", "currentValue": "org=xiaodou-official; repo=xiaodou-open-platform" },
    { "id": 3, "key": "visibility", "status": "DECIDED", "currentValue": "public" },
    { "id": 4, "key": "licenses", "status": "DECIDED", "currentValue": "content=CC-BY-4.0;code=MIT" },
    { "id": 5, "key": "publishMethodAndSigner", "status": "DECIDED", "currentValue": "publishMethod=git-commit-tree-single-tree-snapshot;signer=luwulei" }
  ],
  "publicRepoPushAuthorized": true,
  "blockedReason": null
}
```
<!-- /xd-publishing-parameters -->

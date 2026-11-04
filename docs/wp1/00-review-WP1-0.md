# WP1-0 独立 Review 结论（留档）

审查方：独立子 Agent（只读，未改任何文件）
被审范围：`873e554..be98ab9`（生产修复 + zod 升级 + setup 脚本 + evidence）
审查员独立复跑：`pnpm typecheck` EXIT 0；`pnpm test` 1339 / 1337 pass / 0 fail / 2 skipped；`pnpm install --frozen-lockfile` EXIT 0；`pnpm audit --prod` 与 `--all` 均 0 漏洞。

## 总评

**APPROVE WITH NITS** — 四项被审内容全部通过（修复正确、`test/` 零改动、zod 升级合规、脚本未触红线、证据可复核）。

## 两条 major（均已处理）

### M1 commit `be98ab9` 混入无关的 workbench-core 半成品，HEAD 处是坏包

- 事实：`workbench-core/{package.json,src/errors.js,src/store.js,src/validate.js}` 进入了 WP1-0 的 commit，而 `package.json` 的 `exports` 指向 `./src/index.js`，该文件当时未提交 → HEAD 上 `require('@local/workbench-core')` 会失败。
- 处理：**不重写历史**（改写已推送前的 commit 有回退风险），改为在后续 commit 中补齐 `workbench-core` 全部模块（`index.js` 等），使 HEAD 不再悬空；并在 `docs/wp1/01-WP1-core-domain.md` 中记录该污染与补救。

### M2 文档核心论证与实测不符

- 我的原文声称「真实 profile 经符号链接也会算错，修复的是生产缺陷」。
- 审查员实测推翻：`PRAGMA database_list.main.file` **永远返回 realpath**（目录符号链接 / 叶子符号链接 / 直接打开三者一致，实测 `SAME? true`），且 `service.ts` 从不注入 `ownerDbKey`（grep 为 NONE）→ **生产两侧都走 PRAGMA，修复前也没算错过**。
- 真实不对称是「测试夹具用词法 `dbPath` 算 key vs 生产用 PRAGMA 算 key」。修法正确，但**对生产是 no-op**。
- 处理：`docs/wp1/00-WP1-0-build-env-and-fix.md` 已按实测改写，明确写出「修法正确，但对生产是 no-op」。

## 五条 minor / nit（记录在案）

| # | 内容 | 处理 |
| --- | --- | --- |
| 3 | 文档引用不存在的 `evidence/wp1-0/review-*.md` | 已改为指向本文件 |
| 4 | `install.ts:263/266` 的 `catch {}` 不区分错误码，EACCES/ELOOP 也静默降级 | 记录为已知限制（概率极低、降级方向保守：只跳过不动文件）；未改代码，避免为极端场景引入新分支风险 |
| 5 | `evidence/` 含 16 处 `/Users/sylas/...` 本机绝对路径 | 记录；仓库当前无 remote、不进 HTTP。后续公开前需脱敏（已列入 WP1-6 收口清单） |
| 6 | `scripts/wp1-setup.sh` 硬编码 rolldown binding `1.1.5` | 记录为已知限制：上游升级 rolldown 后需同步改脚本；WP1-6 收口时改为从 lockfile 读版本 |
| 7 | node 版本越界只 WARN 不 exit，与「失败即退」表述不一致 | 记录；文档已注明这是 warn-only |
| 8 | 两份测试日志各 336KB、内容近乎重复 | 记录；后续只留 final 一份 |
| 9 | 叶子符号链接 + 目标未建时 key 不收敛（实测 `CONVERGED: false`） | 记录；实际不触发（DB 打开时文件必然已存在，且 PRAGMA 返回真实目标） |

## 审查员已核实无问题项（摘要）

`test/` 零改动（硬红线）· 修复真收敛（OLD fixture vs recovery `false` → NEW 两侧 `true`）· 内存 DB 分支完好 · WeakMap 缓存仍在 · 调用面完整（全仓仅 `computeOwnerDbKey` + 测试两处）· Windows 大小写语义保持 · 2 个 skip 是正当平台条件 · 修复前 5 红可复核 · zod 4.6.7 满足全部 4 个消费方 `^4.4.3` · OSV 查证 `fixed 4.6.6` / HIGH / CWE-770 · audit 全 0 · zod 只在 dev 链 · 连带升级 schemastery/cosmokit 的 lib 字节完全相同 · lockfile 可冻结安装 · setup 脚本幂等且失败即退 · 脚本不碰红线（grep 无 `~/.dsh`/push/publish/sudo）· remote 为空 · 未污染 DSH（`~/.dsh/workbench` 不存在、4 个 profile 配置无 dely0）· 鲸鱼娘 `plugin/` 仍 `79d7e24` dirty 0 · 证据全 git-tracked。

## 剩余风险

1. ~~文档论证不成立~~ → 已修正。
2. ~~HEAD 上 workbench-core 是坏包~~ → 已由后续 commit 补齐（见 `01-WP1-core-domain.md`）。
3. EACCES 降级路径：概率极低，降级方向保守，不阻塞。
4. setup 脚本平台受限：非 darwin-arm64 直接 `exit 1`，可复现性只在 Apple Silicon macOS 成立——已在脚本注释与 WP1 文档中声明。
5. 未验证项：`npm pack` 恢复 binding 的分支本次未触发（binding 已存在），tarball 文件名与硬编码是否一致未实测。

# WP4 证据索引

每一项都可复核。命令均可复制执行。

## 1. 真实 DSH 隔离环境加载

| # | 证据 | 内容 |
| --- | --- | --- |
| 01 | `01-isolated-boot-before-fix.log` | 首次隔离 boot：抓到真缺陷 `cannot get property "approval" without inject`（静态测试测不到） |
| 02 | `02-isolated-boot-after-fix.log` | 修复后：零错误、零 did-not-activate |
| 03 | `03-isolated-load.md` | 完整加载验证记录：安装命令、隔离 DSH_HOME、红线核查、诚实边界 |
| 04/07/09/10 | `*-isolated-boot*.log` | 第二、三、四轮修复后的复核 boot，均零错误 |

复现：
```bash
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue \
  --patch /tmp/wp4-isolated-patch.yml --no-open --port 0
# 12 秒后 kill；日志应只有一行 dsh web: http://127.0.0.1:<port>/?token=...
```

## 2. 真 Host 审批（ApprovalService）

| # | 证据 | 内容 |
| --- | --- | --- |
| 05 | `05-real-approval-after-fixes.log` | 真 `ApprovalService` + open-turn session → `approved:true` + token + 审计 `approval/asked,approval/decided` |
| 08 | `08-real-approval-after-round2-fixes.log` | 第二轮修复后复核，仍 PASS |

复现：`node /tmp/wp4-approval-real.mjs`（脚本逻辑见 `workbench-core/test/host-approval-real.test.mjs`）

## 3. 独立 Review 结论

| 文件 | 轮次 | 结论 |
| --- | --- | --- |
| `final-review/VERDICT.md` | 第 1 轮（基准 `1a2c7ef`） | 🔴 REQUEST CHANGES（5 blocker） |
| `final-review/REVIEW-round3.md` | 第 3 轮（基准 `548be95`） | 🔴 REQUEST CHANGES（1 blocker + 1 MAJOR） |
| `final-review/REVIEW-round4.md` | 第 4 轮（基准 `bf1c657`） | 见文件末尾结论 |
| `06-review-response.md` | 第 1–2 轮响应 | 逐条修复记录 |

## 4. 测试与变异

| 项 | 命令 | 期望 |
| --- | --- | --- |
| 单元/集成 | `cd workbench-core && node --test test/*.test.mjs` | 279/279 |
| Client→Host→Storage 桥 | `node --test test/workbench-ui-bridge.test.mjs` | 23/23（真 Remote 信封、真 dsh-commands 形状、真文件落盘） |
| 组件渲染 | `node --test test/workbench-ui-render.test.mjs` | 4/4（真实调用组件，捕获渲染期异常） |
| UI 规范静态 | `node --test test/workbench-ui-standards.test.mjs` | 10/10（令牌/尺寸/键盘/审批/manifest/locale） |
| 变异 | `node scripts/r3-mutate.mjs /tmp/mut.log` | 49/49 CAUGHT，0 VACUUM，0 SKIP |
| 门禁 | `bash scripts/wp2-r5-gate.sh` | 8/8 PASS |
| O(N²)/线性性能基准 | `node scripts/bench-reconcile.mjs` | 见 `docs/wp3/01-on2-registry.md`（UNRESOLVED） |

## 5. 冻结纪律

- 每个 Review 基准都生成了逐字节一致的冻结副本（`git archive` + `diff -rq` 核验）。
- 审查期间被审 commit 未改动（各轮都记录了开始/结束 HEAD）。
- 变异脚本会临时改源码，**一律在 /tmp 副本跑**，主仓库不留残留
  （`mutation-backup` 文件已核验为 0）。

## 6. 红线核查

| 红线 | 核验命令 | 期望 |
| --- | --- | --- |
| 正式 profile 未改 | `grep -c workbench-ui ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/cordis.patch.yml` | 0 |
| 未 push | `git remote -v` | 空 |
| 其他项目未碰 | `cd ~/Developer/鲸鱼娘/plugin && git status --porcelain` | 空 |
| 未伪造截图 | `ls evidence/wp4/` | 仅 `.log` / `.md` |

## 7. 未取得的证据（如实登记）

| 项 | 原因 |
| --- | --- |
| 深浅色截图 | Client Inspect Provider 不可用；`references/verification.md` 禁止另起浏览器 / rasterizer / 模拟 React-DOM 补截图 |
| 窗口缩放实际效果 | 同上（仅静态 @media 核查） |
| 真实点击 / 键盘操作 | 同上（仅静态 role/aria/focus 核查） |
| 浏览器网络层 `ctx.remote.commands.execute` 端到端 | 无浏览器控制；Host 半边与命令契约已真实验证 |
| 真实 macOS 通知 / 休眠唤醒 | 按授权保留至后续工作包 |

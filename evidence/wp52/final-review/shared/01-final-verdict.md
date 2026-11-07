REQUEST CHANGES

# WP5.2 最终独立 Review · 汇总裁决（REQUEST CHANGES）

**日期**：2026-11-07
**冻结 commit**：`e9b2b329b50c7e69f29d873da090c928528e61a5`
**冻结副本**：`/tmp/wp52-freeze-e9b2b32`（tree digest `131e8c74bcbd21d1dc23ea480b0cdc2c716cfb9e`，
审查前后两次复核一致；无 `.git`，`chmod -R a-w`）

## 裁决

| Agent | 范围 | verdict 第一行 | Blocker |
|---|---|---|---|
| A | 所有权白名单 / 误删保护 / 持久化恢复 | **APPROVE** | 0 |
| B | 跨 session-scope 隔离 / 投递去重 / Host 审批安全 | **REQUEST CHANGES** | **1 个 P0** |

**综合裁决：REQUEST CHANGES —— WP5.2 暂不关闭。**

> **变更说明**：本汇总初版写的是 APPROVE（把冒号缺陷定成 P1）。
> 独立 Agent B 迟到产出 `probe-scope-colon.log`（S1/S3）给出更硬的证据：
> 3 次写操作 → 3 条 active 提醒 → 到点**重复投递 3 次**，且孤儿只增不减、
> 白名单无法收敛。重复投递是**产品行为错误**，命中本轮重点「真实投递去重」，
> 构成 P0 blocker。按用户「如无 blocker 则关闭」的口径，**不能关闭**。
> 裁决随证据改，不嘴硬。

## 独立性说明（如实记录）

独立 Agent 通道经历了「启动失败 → 迟到恢复」：

| 通道 | 结果 |
|---|---|
| `subagent_fork` ×2 | 启动即失败，无产出 |
| `subagent` ×2 | 报「failed before it finished」，**但 Agent B 后来恢复并产出文件** |

因当时误判为全部失败，Lead 改用「冻结快照 + 独立 `node` 进程 + 探针脚本 +
不可篡改日志」完成 A/B 两组探针。之后独立 Agent B 迟到产出
`probe-dedup.mjs` / `probe-approval.mjs` 及日志（时间戳 18:02–18:04），
**并发现了 Lead 探针漏掉的 P1 缺陷**（scope 含冒号 → 重复注册）。

因此本轮实际形成了**两套独立探针交叉验证**：Lead 的冻结探针（A 30 项 / B 26 项）
+ 独立 Agent B 的对抗探针。后者发现的 FAIL 已逐条甄别：
1 个真缺陷（P1）、4 个探针预期错误，全部记录在 `agent-b/findings.md` 补录节。

**诚实说明**：曾一度把 Agent B 判成「启动即失败」，若不复查文件时间戳就会
漏掉它的发现。证据目录里的 `probe-dedup.*` 与 `probe-approval.*` 是它留下的，
本汇总据实收录。

## 证据清单

| 文件 | 内容 |
|---|---|
| `shared/00-freeze-and-evidence.md` | 冻结对象、复用证据、分工、红线 |
| `agent-a/probe-ownership.mjs` | 白名单/误删/持久化探针（30 项） |
| `agent-a/probe-ownership.log` | PASS=30 FAIL=0 |
| `agent-a/findings.md` | A1–A5 逐条命令→输出→判定 |
| `agent-a/verdict.md` | 第一行 `APPROVE` |
| `agent-b/probe-isolation.mjs` | 隔离/去重/审批探针（26 项） |
| `agent-b/probe-isolation.log` | PASS=26 FAIL=0 |
| `agent-b/probe-approval-real.log` | 真 ApprovalService 2/2（0 skip，重建 asar 后） |
| `agent-b/findings.md` | B1–B5 逐条命令→输出→判定 |
| `agent-b/verdict.md` | 第一行 `APPROVE` |

## 重点审查结论

1. **所有权白名单**：用户伪造完全合法的标记（含不可见前缀、scope 自洽）时，
   `ownershipOf` 判 `owned`，但最终删除判据是白名单 ——
   `deleted=0 / kept=1 / delete 调用 0 次`。**标记不是认证，白名单才是防线。**
2. **误删保护**：`suspect`/`foreign` 一律不删且进 `observed`；读失败 → 少删；
   落盘失败不阻塞 create 且同进程幂等。无「故障导致多删」窗口。
3. **持久化恢复**：跨进程读同一磁盘后仍能清理；两 scope 白名单不混、互不越权。
4. **跨 session/scope 隔离**：A 看不到 B 的记录；projB 只删自己的。
5. **投递去重**：同一 identity 连续三次 reconcile 只 create 一次；
   与真机 `user/message` 仅 1 次一致。
6. **Host 审批安全**：无 token 拒、`confirmed` 不采信、token 一次性、
   绑定内容摘要、重复导入幂等（skipped=1）且审批未破坏。

## 非 blocker 的观察项（进 WP6 清单）

| 级别 | 内容 |
|---|---|
| P2 | `host-approval-real.test.mjs` 依赖外部 `/tmp/dsh-asar-full` 解包目录；目录缺失时按设计明确 SKIP 2 个测试（不伪装通过），使「437/437」不可无条件复现。建议固化为测试前置检查。 |
| P2（已披露） | 白名单落盘失败 / WP5.1 旧格式记录 → 留孤儿。有意取舍：留孤儿可恢复，误删不可恢复。见 `02-delivery.md` §6.5。 |
| 探针自身 | Agent A 的 A4.6 初版断言预期写错导致 1 个 FAIL；诊断确认是探针错误、非产品缺陷，已修正重跑（30/30 PASS）。 |
| **P0 BLOCKER** | **scope 含冒号时 `reminderIdentity`/`decodeIdentity` 往返失败 → 重复注册 → 重复投递**（独立 Agent B `probe-dedup.log` Q3.4/Q3.5、`probe-scope-colon.log` S1/S3）。3 次写操作 → 3 次投递，无法收敛。**必须修复后复审再关闭**。 |

## 保持 UNVERIFIED（不因关闭而改变）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。详见 `02-delivery.md` §6。

## 红线确认

- ✅ 冻结副本只读，digest 审查前后一致
- ✅ **未修改任何业务代码**（主仓库 `git status` 仅有新增证据目录）
- ✅ 未重复无价值的全量研究（复用 437/437 与 135/135 既有证据）
- ✅ 未触碰正式 DSH profile / 真实用户数据
- ✅ 两份 verdict 均明确给出 APPROVE，无模糊表述

## 结论

**REQUEST CHANGES —— WP5.2 暂不关闭。**
1 个 P0 blocker（含冒号 scope 导致重复投递）须先修复、补测试与变异项、
再做一次针对该缺陷的复审；通过后才能正式关闭。

按用户授权，本轮**仍不进入 WP6 实施**，WP6 实施清单（含此 P0 的修复任务）
见 `02-wp6-plan.md`，仅供规划。

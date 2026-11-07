REQUEST CHANGES

# Agent B 裁决：REQUEST CHANGES

**冻结 commit**：`e9b2b329b50c7e69f29d873da090c928528e61a5`
**范围**：跨 session/scope 隔离 / 真实投递去重 / Host 审批安全
**证据**：`probe-isolation.mjs`/`.log`（Lead 冻结探针）、
`probe-dedup.mjs`/`.log`、`probe-approval.mjs`/`.log`（独立 Agent B 迟到产出）、
`probe-approval-real.log`（2/2 真通过，0 skip）、`findings.md`

## 裁决依据

1. **跨 session 隔离成立**：`catalog()` 全表下，session-A 对空数据对账时
   `delete`/`update` 调用均为 0，B 的记录完好。`ownHostRecords` 的 sessionId
   过滤在最外层，A 根本看不到 B 的记录。
2. **跨 scope 隔离成立**：projB 只删自己那条；projA 的记录被判
   `suspect/scope-mismatch` 进 `observed` 并保留。
3. **投递去重成立**：同一 identity 连续 reconcile 三次只 create 一次，
   改期走 update；与真机证据 `user/message` 仅 1 次一致。
4. **目录一致性成立**：`dataDirFor` 与 `forSession` 指向同一目录（写数据核对过），
   桥接层无第二份 hash 实现；scope 含 `::` 已修。
5. **审批安全成立**：无 token 拒、`payload.confirmed` 不采信、token 一次性、
   绑定内容摘要、重复导入幂等且审批未破坏。

## Blocker（1 个 P0）

**scope 含冒号时同一提醒重复投递。**
`probe-scope-colon.log` S1/S3 实证：3 次写操作 → 3 条 active 提醒、
3 次 create，且每条都满足 `drive()` 的 `scheduledAt<=now` 投递条件
（无 identity 去重）→ 到点**重复投递 3 次**；自家记录恒被判 suspect，
白名单与 observed 无法收敛，孤儿只增不减。

这命中本轮重点审查项「真实投递去重」，是**产品行为错误**而非可观测性瑕疵。
按「如无 blocker 则关闭」的口径，**不能关闭 WP5.2**。

## 缺陷详情（P0）

**scope 含冒号时 identity 无法往返 → 重复注册 → 重复投递。**
位置：`reminder-sync.js` `reminderIdentity` / `decodeIdentity`。
独立 Agent B 的 `probe-dedup.log` Q3.4/Q3.5 实证：`scope='a::b'` 连续
reconcile 两次 `create=2`、Host 行数=2；`task:a::b:e1` 被解成 scope=`a`。

- 触发需含冒号的 scope（外部可传；契约里 `project` 可作 scope）。
- **后果是重复投递**（非仅重复注册），且无法自动收敛。
- 不误删、不越权，但足以构成 blocker。
- 修法：`reminderIdentity`/`decodeIdentity` 改用不与 scope 冲突的分隔
  （`encodeURIComponent` 或 `\u0000`），补含冒号 scope 的往返测试与变异项。

独立 Agent B 其余 FAIL 经逐条实证均为探针预期错误（Q3.2b/Q4.1/Q4.5/Q4.6），
详见 `findings.md` 补录表，不作为缺陷。

## P2 观察项（不构成 blocker，建议进 WP6 清单）

`host-approval-real.test.mjs` 依赖外部 `/tmp/dsh-asar-full` 解包目录。
目录缺失时按自身设计明确 SKIP 2 个测试（不伪装通过），
导致「全量 437/437」**不可无条件复现**。重建解包后 2/2 真通过，
且 `init` 直接断言确实在代码里。
建议把该依赖固化为测试前置检查或在 CI 中显式声明。

## 审查过程诚实记录

独立 Agent 通道在本环境启动即失败（无任何产出）。独立性改由
「冻结快照 + 独立 node 进程 + 探针脚本 + 不可篡改日志」实现。
本文所有判定均来自实际运行探针的输出，非静态阅读推测。

## UNVERIFIED（保留）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。见 `02-delivery.md` §6。

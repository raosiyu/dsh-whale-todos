# WP6 实施清单：AI 智能任务规划与会话协作

> **本文件只规划，不实施。** WP5.2 已正式关闭（见 `01-final-verdict.md`）；
> WP6 的实施须另行授权。以下清单基于冻结 commit `e9b2b329` 的真实代码现状整理，
> 不引入未核实的 Host 契约。

## 0. 现状基线（实测，非推测）

| 事实 | 证据 |
|---|---|
| AI 工具 16 个，全部是**确定性 CRUD/预览**，无「规划/拆解/建议」类 | `host-tools.js` 工具名清单 |
| `subtasks` 只是 `title` 字符串数组，无状态/负责人/依赖/进度 | `host-tools.js:232` `Subtask titles.` |
| 数据按 `sessionId × scope` 分片，目录名是 sha256 前缀、不可逆 | `host-service.js:37,151` |
| `ctx.schedule` 已接入，提醒可持久化投递 | WP5.1/5.2 |
| 审批门控 `DANGEROUS_OPS` + 一次性 token + 内容摘要 | `service.js`，终审 B5 |
| 撤销/重做栈持久化，默认深度 20 | `history.js`、`store.js` |
| 所有写操作经统一 `service.invoke(sessionId, op, payload, meta)` | `host-service.js:166` |

## 1. 目标与不做什么

**目标**：让 AI 能把一句模糊目标拆成可执行的待办/日程，并让多个会话在同一份
工作区数据上安全协作（不越权、不覆盖、可追溯）。

**明确不做**（防 scope creep）：
- 不做 macOS 系统通知（DSH 与 `ctx.schedule` 都不提供，WP5.2 已确认）
- 不做真实 macOS 睡眠/VoiceOver 的自动化验收（沿用 UNVERIFIED）
- 不改正式 DSH profile、不写真实用户数据
- 不新增外部依赖、不引入新服务契约（复用已核实的 `ctx.schedule` / commands / storage）
- 不自动发布、不改仓库可见性

## 2. 实施分解（按依赖顺序）

### WP6-A · 契约与数据模型先行

| # | 任务 | 验收信号 |
|---|---|---|
| A1 | 写 `docs/wp6/00-contract.md`：定义「规划提案（proposal）」与「落地（commit）」两阶段，禁止 AI 直接写业务数据 | 契约明确写出「AI 产出提案 → 用户确认 → 走统一 Host 入口」 |
| A2 | 扩展 `subtasks`：从 `string[]` 升级为结构化对象（`id/title/done/order`），**保留旧数组的读兼容** | 旧数据可读、新数据可写、迁移测试通过 |
| A3 | 为 task 增加可选 `sourceSessionId` / `planId` 溯源字段（**不覆盖既有字段**） | 字段完整性测试：AI 与 UI 两条路径都不丢 `priority/status/subtasks` |
| A4 | `WRITE_OPS` / `DANGEROUS_OPS` 复核：规划类操作若写数据，必须进相应清单 | deny 模式下新操作一律被拒 |

**风险**：A2 是数据模型变更，改动面大。必须先写迁移与回归，再动结构。

### WP6-B · AI 智能任务规划（只读提案 → 显式落地）

| # | 任务 | 验收信号 |
|---|---|---|
| B1 | 新增只读工具 `workbench_plan_preview`：输入自然语言目标 + 时间窗，输出**结构化提案**（任务/子任务/建议日程/冲突提示），**不写任何数据** | 调用后 `workbench.json` 零变化；提案含 conflicts 与 reasoning |
| B2 | 提案必须复用既有 `event.conflicts` / `event.freeSlots` / `task.list` 的真实数据，不自己造一份真相源 | 探针断言提案里的冲突来自服务端 `checkEventConflicts` |
| B3 | 新增 `workbench_plan_apply`：必须带**用户审批 token**才落地，逐条转调 `task.upsert` / `event.create`，折叠成一条 undo | 无 token 被拒；落地后 undo 一次即可整体撤销 |
| B4 | 落地失败回滚：沿用 `store.backup` + `store.rollback`，原子性 | 中途注入失败后数据回到提案前 |
| B5 | AI 工具描述与参数 schema 遵循 `agent-experience` 规范（可发现、可组合） | 独立 Review 检查工具命名/描述/参数 |

**红线**：B3 绝不允许绕过审批；`payload.confirmed` 不被采信（与 WP5.2 终审 B5 一致）。

### WP6-C · 会话协作

| # | 任务 | 验收信号 |
|---|---|---|
| C1 | 明确 `scope` 的语义与分配规则（当前 scope 是内部字符串，无文档） | 契约写明「谁可以读写哪个 scope」，含含 `::` 的边界 |
| C2 | 新增只读 `workbench_scope_list`：列出本进程可访问的 scope 及其来源 session（**只暴露 sessionId，不暴露 sha256 目录名反查表**） | 输出不含目录名；`sessionEntries` 不外泄 |
| C3 | 跨 scope 引用必须显式、可审计：任何写操作带 `scope` 时记入 audit | audit 里有 scope 字段，且不记录 payload 全文 |
| C4 | 并发写入保护：沿用 `service.invoke` 单一入口；评估 `compare-and-update`（参考 `schedule.update` 的 `expected` 语义）是否需要引入 | 并发探针：两个会话同时改同一实体，不静默覆盖 |
| C5 | 协作冲突提示：当 A 的实体被 B 改过，UI/AI 能看见冲突而不是悄悄覆盖 | 冲突可复现、有提示、可撤销 |

**已知硬约束**：`sessionDirName` 是 sha256 前缀、不可逆，
**重启后无法反推出老会话的 sessionId**（WP5.2 §6.4）。
C2 只能列「本进程打开过的 session」，不得宣称全量。

### WP6-D · 测试基础设施（承接终审 P2 观察项）

| # | 任务 | 验收信号 |
|---|---|---|
| D1 | 把 `host-approval-real.test.mjs` 的 `/tmp/dsh-asar-full` 依赖固化为**显式前置检查**：缺失时要么自动准备、要么明确报「环境未就绪」，而不是静默 SKIP | CI 里数字可无条件复现；缺失时不会显示「全绿」 |
| D2 | 把终审探针（`final-review/agent-a|b/probe-*.mjs`）纳入常规回归或独立 `verify` 脚本 | 一条命令可复跑安全性判据 |
| D3 | 给 `ctx.schedule` 相关测试补「真 Host 契约」与「fake 契约」的分层标注，防止替身比真宿主宽松 | 每个 fake 都注明对应的真实守卫来源 |

### WP6-E · 验收与收口

| # | 任务 |
|---|---|
| E1 | 隔离环境真机验证：AI 提案 → 用户确认 → 落地 → 撤销 → 跨会话可见 |
| E2 | 完整回归 + 变异验证（沿用 `r3-mutate.mjs`，新增保护点必须补变异） |
| E3 | 独立 Review（明确 APPROVE / REQUEST CHANGES） |
| E4 | Git diff / Secrets / PUBLIC-01 检查后精确暂存提交，禁止 `git add -A` / force push |
| E5 | 输出证据、Git hash、UNVERIFIED 清单，完成后 STOP |

## 3. 承接自 WP5.2 的 UNVERIFIED（不得在 WP6 里被悄悄抹掉）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。

## 4. 承接自终审的缺陷与观察项

### 4.1 P0 BLOCKER（终审发现，**必须先修复并复审，WP5.2 才能关闭**）

**scope 含冒号时 identity 无法往返 → 重复注册 → 重复投递**

| 项 | 内容 |
|---|---|
| 位置 | `workbench-core/src/reminder-sync.js` `reminderIdentity` / `decodeIdentity` |
| 证据 | `final-review/agent-b/probe-dedup.log` Q3.4/Q3.5：`scope='a::b'` 连续两次 reconcile `create=2`、Host 行数=2 |
| 根因 | identity 用 `:` 拼 `kind:scope:entityId`，但 `decodeIdentity` 的 `([^:]*)` 只吃不含冒号的 scope |
| 影响 | 重复注册 → **重复投递**（`probe-scope-colon.log`：3 次写 → 3 条 active → 到点投递 3 次）；自家记录恒判 suspect，白名单无法收敛，孤儿只增不减 |
| 修法 | scope 用 `encodeURIComponent` 或改用 `\u0000` 分隔；补含冒号 scope 的往返测试 + 变异项 |
| 验收 | 含 `a::b` / `x:y:z` 的 scope 连续 reconcile 三次 `create` 恒为 1，`decodeIdentity` 往返一致 |

> **终审结论因此改为 REQUEST CHANGES，WP5.2 暂不关闭。**
> 此缺陷虽不误删/不越权，但造成重复投递且无法自动收敛，是产品行为错误，
> 命中本轮重点「真实投递去重」。须先在 WP5.2 范围内修复、补测试/变异、
> 针对该缺陷复审通过后才能正式关闭；WP6 不得带着它开工。

### 4.2 观察项

- `host-approval-real` 的 asar 外部依赖（→ D1）
- 白名单落盘失败 / 旧格式记录留孤儿（有意取舍，文档保留）
- 独立 Agent 通道在本环境「启动失败 → 迟到恢复」→ WP6 若需独立 Review，
  用「冻结快照 + 独立进程探针」并**在结束前复查目录时间戳**，避免漏掉迟到产出

## 5. 优先级建议

```
A（契约/数据模型） → B（AI 规划，依赖 A） → C（协作，可与 B 并行但需 A 的 scope 定义）
→ D（测试基建，独立可提前） → E（验收）
```

D1/D2 可**提前单独做**：它们不改业务代码、风险最低，且能让后续所有验收数字
变得可复现。这是「小步快跑」里最该先跑的一步。

**但 §4.1 的 P0 不属于 WP6 实施范围**：它是 WP5.2 的关闭前置条件，
须单独立项修复并复审。WP6 的 A–E 全部排在它之后。

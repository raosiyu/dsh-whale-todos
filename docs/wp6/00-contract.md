# WP6 契约：AI 智能规划与 Agent 会话协作

> 基线 commit `d81e99a96f12f15269c21b998def43c284d6e5be`
> 状态：**WP6-A 开工契约**。本文件先于代码，所有新增能力必须对齐此处的真实接口与红线。

## 0. 侦察结论（一手核实，非推测）

### 0.1 DSH 真实接口（app.asar 一手源码，`/tmp/wp6-asar/dsh/node_modules/@deepseek-ai/`）

| 能力 | 真实契约 | 证据 |
|---|---|---|
| 工具定义 | `defineTool(options)` → `{name, description, parameters, output:{schema,render}, execute(args, exec)}` | `dsh-tools/lib/index.js:310` |
| 工具注册 | `ctx.tools.register(definition)` 返回 disposer | `dsh-tools/lib/index.js:433`（既有 `host-tools.js:17` 已实证） |
| sessionId 唯一来源 | `exec.agent.session.id`（**无** `exec.sessionId`） | 既有 `host-tools.js:18,101`，`dsh-tool-schedule` 实证 |
| 自然语言映射 | **DSH 不内置 NLP**：注册工具后 schema 自动进 system-prompt，模型自己把自然语言映射到工具参数 | `docs/wp3/03-natural-language-and-unified-api.md` §1 |
| Session 控制 | `sessionController.resolveAgent(sessionId)`（Host 侧） | `dsh-api-session-controller/lib/index.js:181` |
| 提醒/投递 | `ctx.schedule`（WP5.1/5.2 已接入） | — |
| 命令通道 | `ctx.commands.register` + `ctx.remote.commands.execute(sessionId, line)` | 既有 `packages/workbench-ui/index.js` |

**关键设计结论**：WP6 的「AI 理解自然语言」**不是**自己写解析器，而是
「设计好结构化工具 + 写清 description/parameters」，让 DSH 的模型完成语义映射。
规划/拆解/提案预览都是**确定性结构化工具**，AI 负责把用户意图翻译成参数。

### 0.2 既有项目能力（复用，不重写）

| 能力 | 位置 | WP6 如何用 |
|---|---|---|
| 统一业务门面 `service.invoke(sessionId, op, payload, meta)` | `host-service.js:166` | 所有新 op 挂同一 dispatch 表；UI 与 Agent 共用 |
| `createWorkbenchService` 的 `ops` dispatch 表 | `service.js:235` | 新增 op 直接挂进去 |
| `store.collection(name)` / `mutate` | `store.js:235,243` | 新集合 `proposals` / `sessionLinks` |
| 撤销快照只含 `events`+`tasks` | `store.js` `UNDOABLE_KEYS` | 提案/会话关联**不进 undo 栈**（正确：不该被 Cmd+Z 撤销） |
| 审批门 `DANGEROUS_OPS` + 一次性 token + `contentDigest` | `service.js` | 规划落地必须走审批 |
| 备份/回滚 `store.backup` / `rollback` | `store.js` | 落地失败整体回滚 |
| 冲突检测 `checkEventConflicts` / `event.freeSlots` | `conflict.js`, `service.js` | 规划排期复用**唯一真相源** |
| 审计 `draft.audit.push` | `service.js` | 新 op 全部写审计 |
| AI 工具工厂 `createWorkbenchToolDefinitions` | `host-tools.js` | 增量加规划/协作工具 |
| 16 个既有 AI 工具 | `host-tools.js:161-376` | 保持不变 |

### 0.3 Dely0 快照的复用（**机制**，不是代码）

`upstream/dely0-v1.17.2` 是 SQLite + 独立 HTTP 架构，与本项目的
零依赖 JSON + DSH Host Service 架构**不兼容**，禁止直接复制代码。
但下列**设计模式**经核实可复用：

| Dely0 机制 | 位置 | WP6 对应 |
|---|---|---|
| `task_sessions` 关联表（task↔session，带 role） | `src/db/repo/task-sessions.ts` | task 上新增 `sessionLinks: [{sessionId, role, note, at}]` |
| `findTaskIdBySession` 反查 | 同上 | `session.get`/`task.bySession` 只读 op |
| 每日计划草稿 → `confirmDailyPlanDraft` 才落库 | `src/db/repo/plans.ts:486` | 提案两阶段：`proposal.preview`（只读）→ `proposal.apply`（审批后落库） |
| `dailyPlanPolicy` 单一权威口径 | `src/shared/dailyPlanPolicy.ts` | 规划校验集中在 `planning.js`，工具/UI/服务共用 |
| `checkPlanMinutes` 严格校验（非法整份拒绝） | 同上 | 提案里 `estimatedMinutes` 严格校验 |
| **AI 只能提交「完成验收申请」，不能自行完成任务** | `src/tools.ts:866,914-915` | `task.requestCompletion` 只建验收草稿；`task.acceptCompletion` 只由用户确认 |
| 进度 `100` 不是进度，是「转验收申请」 | 同上 | 沿用：AI 写进度上限 99 |

## 1. 数据模型（新增，不破坏既有）

### 1.1 新集合（store.collection）

```
proposals: Proposal[]
sessionLinks: 不单独建集合，挂在 task.sessionLinks 上（见 1.3）
```

`StoreShape` 新增两个可选集合键 `proposals`（`taskExecutions` 如需则另加），
读兼容：`state[name] ?? []`。`undo`/`redo` 仍只快照 `events`+`tasks`。

### 1.2 Proposal（规划提案，绑定目标/版本/操作）

```js
{
  id: string,              // 提案 id（proposal-<uuid>）
  kind: 'plan'|'decompose'|'schedule'|'mixed',
  status: 'pending'|'applied'|'rejected'|'expired',
  sessionId: string,       // 创建者 sessionId（唯一来源 exec.agent.session.id / commands invocation）
  scope: string,           // 绑定 scope
  sourceText: string,      // 用户原始自然语言（截断存，不记全文）
  baseVersion: number,     // 提案生成时的 store.version（防确认后数据被替换）
  baseDigest: string,      // 提案生成时 events+tasks 的内容摘要
  items: ProposalItem[],   // 见下
  reasoning: string,       // AI 给出的原因说明（不可信输入，仅展示）
  conflicts: object[],     // 来自 checkEventConflicts 的真实冲突
  createdAt: string,
  decidedAt?: string,
  applyToken?: string,     // 不存 token 明文；仅存「已用」标记，见 §3
}
```

`ProposalItem`（每条绑定具体操作，防确认后替换）：

```js
{
  op: 'task.create'|'task.update'|'event.create',  // 只能是白名单 op
  targetId?: string,        // update 时绑定既有实体 id
  targetVersion?: number,   // update 时绑定该实体版本
  payload: object,          // 结构化载荷（不可信，落库前再校验）
  reason: string,           // 单条原因
}
```

**红线**：`payload` 绝不直接透传给 `execute`。`proposal.apply` 必须
逐条重新走 `validateEventInput` / `validateTaskInput` + 权限校验 +
目标版本比对，不匹配则整份拒绝（不部分落地）。

### 1.3 Task 新增可选字段（不覆盖既有）

```js
{
  // ...既有 id/title/dueAt/done/priority/status/project/subtasks/order/archived/deleted
  estimatedMinutes?: number,   // 预计耗时（1..1440 整数，非法整份拒绝）
  sessionLinks?: [{            // Agent 会话关联（Dely0 task_sessions 模式）
    sessionId: string,
    role: 'clarify'|'decompose'|'execute'|'review'|'other',
    note?: string,
    at: string,
  }],
  completion?: {              // 人工验收（Dely0 验收草稿模式）
    status: 'pending'|'accepted'|'rejected',
    summary: string,          // AI 提交的完成总结
    requestedAt: string,
    decidedAt?: string,
    decidedBy?: string,       // 只能是用户侧
    feedback?: string,
  },
  executionLog?: [{           // 执行记录/进度回写
    at: string, sessionId: string, progress: number, note: string, evidence?: string,
  }],
}
```

所有字段**可选**；旧数据无这些字段照常读写。既有字段一个不动。

## 2. 工具 / Op 设计（A + B + C 共用）

### 2.1 新增 service op（挂同一 dispatch 表）

| op | 读写 | 说明 |
|---|---|---|
| `proposal.preview` | 只读 | 输入自然语言 + 时间窗 → 生成提案并**存为 pending**（不改 events/tasks） |
| `proposal.list` | 只读 | 列本 session×scope 的 pending 提案 |
| `proposal.get` | 只读 | 取单份提案详情 |
| `proposal.reject` | 写(元) | 用户拒绝 → status='rejected'，**events/tasks 零变化** |
| `proposal.apply` | **写(危险)** | 用户确认 + 审批 token → 校验版本/摘要 → 逐条落地 → 折叠 undo |
| `task.setEstimate` | 写 | 设置预计耗时（走统一校验） |
| `task.linkSession` | 写 | 关联 Agent 会话（校验 sessionId 格式 + scope） |
| `task.unlinkSession` | 写 | 解除关联 |
| `task.bySession` | 只读 | 反查某会话关联的任务 |
| `task.writeProgress` | 写 | Agent 回写进度（0..99，**不**允许置 done） |
| `task.requestCompletion` | 写 | AI 提交完成验收申请（建草稿，不改 done） |
| `task.acceptCompletion` | **写(用户)** | 用户验收通过 → 才置 done；用户侧确认 |
| `task.rejectCompletion` | 写(用户) | 用户驳回 + feedback |

### 2.2 新增 AI 工具（host-tools.js 增量）

| 工具 | 对应 op | 危险？ |
|---|---|---|
| `workbench_plan_preview` | `proposal.preview` | 否（只读+建 pending 提案） |
| `workbench_plan_list` | `proposal.list` | 否 |
| `workbench_plan_get` | `proposal.get` | 否 |
| `workbench_plan_reject` | `proposal.reject` | 否 |
| `workbench_task_estimate` | `task.setEstimate` | 否 |
| `workbench_task_link_session` | `task.linkSession` | 否 |
| `workbench_task_progress` | `task.writeProgress` | 否（上限 99） |
| `workbench_request_completion` | `task.requestCompletion` | 否（只建草稿） |
| `workbench_task_by_session` | `task.bySession` | 否 |

**危险 op（`proposal.apply` / `task.acceptCompletion` / `task.rejectCompletion`）**
**不注册为 AI 工具** —— 与既有约定一致（危险 op 不进 AI 面），
只能由 UI 在用户点确认后经 commands 通道带审批 token 调用。

### 2.3 `workbench_help` 更新

列出全部工具（含新增），标注「AI 不能直接完成任务/删除/批量覆盖」。

## 3. 权限与安全红线

1. **提案两阶段**：AI 只产出 `pending` 提案；`proposal.apply` 必须带
   Host 签发的**一次性审批 token**，`payload.confirmed` 一律不采信。
2. **绑定目标/版本/操作**：`baseVersion` + `baseDigest` + 每条 `targetId/targetVersion`；
   apply 时重算比对，不匹配整份拒绝（防确认后数据被替换）。
3. **跨 Session 权限**：所有 op 的 sessionId 只来自 `exec.agent.session.id`
   或 commands `invocation.agent.session.id`；`proposal.apply` 校验
   `proposal.sessionId === 调用方 sessionId`；scope 一致性校验。
4. **AI 内容不可信**：`sourceText` / `reasoning` / item `reason` 全部当
   不可信文本，仅展示、不执行、不拼进工具描述；存储前截断。
5. **禁止自行完成/删除/批量覆盖**：AI 工具面无 delete/complete/apply；
   `task.writeProgress` 上限 99；`requestCompletion` 只建草稿。
6. **失败恢复**：`proposal.apply` 先 `store.backup`，逐条落地失败
   `store.rollback`，整体回滚；审计记录每次 apply/reject。
7. **审计**：新 op 全部 `draft.audit.push`，记 op/sessionId/scope/结果，
   不记 payload 全文。
8. **deny 模式**：新写 op 必须进 `WRITE_OPS`；`proposal.apply` 进 `DANGEROUS_OPS`。
9. **不引入第三方依赖**；`workbench-core` 保持零 DSH 依赖。

## 4. 阶段验收信号

| 阶段 | 真实可用信号（非文档/非模拟） |
|---|---|
| A | `proposal.preview/list/get/reject` + `task.linkSession/unlinkSession/bySession/setEstimate` 可经 `service.invoke` 调用；新集合持久化、重启可读；deny 模式拦住新写 op；测试 + 变异通过 |
| B | 自然语言输入 → 提案（含拆解/排期/冲突/原因）→ UI 预览 → 用户确认带 token 落地 → 一次 undo 可整体撤销；拒绝时零数据变化；版本不匹配整份拒绝 |
| C | 任务关联 sessionId → 反查可见；Agent 回写进度；提交验收申请但 `done` 不变；用户验收后才 done；AI 工具面无法绕过 |
| D | UI 新增入口/预览/今日本周计划/会话关联/验收入口；中英文 + 主题 + 键盘；自动化测试 + 变异 |
| E | 隔离真机跑通全链路；重启不丢；AI 与 UI 数据一致；并发不覆盖；独立 Review 明确裁决 |

## 5. 不做（防 scope creep）

外部日历同步、多设备同步、macOS 系统通知、真实 macOS 睡眠自动化验收、
VoiceOver、原生拖拽、清理历史 v1 提醒记录、修改正式 profile / 真实用户数据、
自动发布、force push。

## 6. 承接的 UNVERIFIED（保留，不伪报 PASS）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。

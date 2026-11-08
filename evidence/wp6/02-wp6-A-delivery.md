# WP6-A 交付证据：契约 / 真实接口 / 数据模型 / 工具与权限

> 基线 `d81e99a`。本阶段只做 WP6-A（数据模型 + 工具接口 + 权限规范），
> 不实现智能规划算法（WP6-B）、不做 UI（WP6-D）。

## 1. 真实接口核实（一手源码，未自造契约）

| 能力 | 真实契约 | 一手来源 |
|---|---|---|
| `defineTool(options)` | `{name, description, parameters, output:{schema,render}, execute(args, exec)}` | `app.asar` `dsh-tools/lib/index.js:310` |
| `ctx.tools.register` | 返回 disposer | `dsh-tools/lib/index.js:433`（既有 `host-tools.js:17` 已实证） |
| sessionId 唯一来源 | `exec.agent.session.id`（无 `exec.sessionId`） | 既有 `host-tools.js:18,101` |
| 自然语言映射 | **DSH 不内置 NLP**：tool schema 自动进 system-prompt，模型自己映射 | `docs/wp3/03-natural-language-and-unified-api.md` §1 |
| `sessionController.resolveAgent(sessionId)` | Host 侧会话解析 | `dsh-api-session-controller/lib/index.js:181` |
| 命令通道 | `ctx.commands.register` + `ctx.remote.commands.execute` | 既有 `packages/workbench-ui/index.js` |

**设计结论**：「AI 理解自然语言」= 设计结构化工具 + 写清 description/parameters，
由 DSH 模型完成语义映射；本项目**不写 NLP 解析器**。

Inspect Provider（`cordis_inspect_query`）本轮返回「input must be an object」
（连 `{}` 都拒），故改走已验证可靠的一手源码路径，未反复重试同一失败通道。

## 2. Dely0 机制复用（机制，非代码）

`upstream/dely0-v1.17.2` 为 SQLite + HTTP 架构，与本项目零依赖 JSON +
Host Service 架构不兼容，未复制实现。复用的模式：

| Dely0 | 本项目落点 |
|---|---|
| `task_sessions` 关联表 | `task.sessionLinks[]` |
| `findTaskIdBySession` 反查 | `task.bySession` op |
| `confirmDailyPlanDraft` 两阶段 | `proposal.preview`(pending) → `proposal.apply`(审批后) |
| `checkPlanMinutes` 严格校验 | `checkEstimateMinutes`（1..1440，非法整份拒绝） |
| AI 只提交验收申请、不自行完成 | `task.requestCompletion` 只建草稿；`task.acceptCompletion` 才置 done |
| 进度 100 = 转验收申请 | `checkProgress` 上限 99 |

## 3. 新增数据（不破坏既有）

- 新集合 `proposals`（`store.collection` 支持任意键，读兼容 `?? []`）
- `undo` 快照仍只含 `events`+`tasks`（`store.js:42`），提案/会话关联**不进撤销栈**（正确）
- Task 新增可选字段：`estimatedMinutes` / `sessionLinks` / `completion` / `executionLog`
  —— **既有字段一个不动**，旧数据无这些字段照常读写。

## 4. 提案两阶段与绑定（防确认后数据被替换）

```
proposal.preview  →  只建 pending 提案（events/tasks 零变化）
proposal.apply    →  审批 token → 绑定校验(baseVersion/baseDigest/sessionId/scope)
                     → backup → 逐条重校验(白名单裁剪) → 落地
                     → 折叠成一条 undo → 标记 applied
```

任一环节失败：`store.rollback` 整体回滚，提案保持 pending。
AI 内容（`sourceText`/`reasoning`/`reason`）全部 `sanitizeUntrustedText` 净化，
`pickPayload` 白名单裁剪掉 `confirmed`/`approvalToken`/`deleted`/`id`。

## 5. 权限红线（全部有测试）

| 红线 | 落点 |
|---|---|
| AI 不能借提案调危险 op | `PROPOSAL_ALLOWED_OPS` 白名单（3 个 op）+ 测试锁死 |
| `payload.confirmed` 不采信 | `pickPayload` 裁剪；`requireConfirmation` 只认 `meta.approvalToken` |
| `proposal.apply` 必须带一次性 token | `DANGEROUS_OPS` + `requireConfirmation`（实体类只绑 target，不传 digest） |
| 跨 Session 越权 | `sessionId`/`scope` 由 `service.invoke` **受信任参数**注入 op meta，不从 payload 读；`verifyProposalBinding` 校验 |
| AI 不能完成/删除/批量覆盖 | 危险 op 不注册为 AI 工具；`checkProgress` 上限 99；`requestCompletion` 不置 done |
| deny 模式 | 10 个新写 op 全部进 `WRITE_OPS` |
| 失败恢复/审计/撤销 | backup+rollback、每 op 写 audit、折叠成一条 undo |

## 6. 新增 AI 工具（9 个，共 25）

`workbench_plan_preview` / `plan_list` / `plan_get` / `plan_reject` /
`task_estimate` / `task_link_session` / `task_by_session` /
`task_progress` / `request_completion`

**危险 op（`proposal.apply` / `acceptCompletion` / `rejectCompletion` /
delete / bulk / replace）不注册为 AI 工具**，只能由 UI 在用户确认后
经 commands 通道带审批 token 调用。`workbench_help` 的 hint 明确写出这条红线。

## 7. 测试与变异

| 项 | 结果 |
|---|---|
| 全量回归 | 466 / 466 pass，0 fail 0 skipped |
| WP6-A 专项（`proposal-wp6.test.mjs`） | 20 / 20 |
| 变异验证 | 见 `01-mutation-A.log` |

修复过程中实测发现并修掉的两个真缺陷（非文档、非模拟）：
1. `asServiceError` 返回错误却未 `throw` → 校验失败被静默吞掉（空 items/非法 op/
   预计耗时 0/进度 100 全都不报错）。已改为 `throw asServiceError(error)`。
2. `collapseUndo` 放在标记 applied 的 `mutate` **之前** → 折叠后又追加一条
   undo entry，撤销弹到那条、`before` 已含落地数据 → 一次撤销无效。
   已按 WP5 `event.import` 的「折叠必须放在最后」修正顺序。

## 8. 未做（留给后续阶段）

智能规划/拆解/排期算法与提案预览 UI（WP6-B）、会话进度回写 UI 与验收入口
（WP6-C）、UI 集成（WP6-D）、真机验收与独立 Review（WP6-E）。

## 9. UNVERIFIED（保留）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。

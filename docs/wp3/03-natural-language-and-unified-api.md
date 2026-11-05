# WP3：自然语言操作与统一业务方法

## 1. 自然语言操作怎么落地（不重造 NLP）

**DSH 的真实机制**：`ctx.tools.register(defineTool(...))` 之后，工具的
`name` / `description` / `parameters` schema **自动进入 system-prompt 装配**
（`dsh-tools/README.md`「Registering a tool is enough to make it visible —
the registry feeds its schemas into the system-prompt assembly automatically」）。
模型读到 schema，自己把自然语言映射到工具与参数。

因此本项目**不内置 NLP 解析器**（那是不完整且会分叉的第二套状态机）。我们做的是：
- 每个工具写清意图与参数语义（见 `host-tools.js` 的 description）；
- `workbench_help` 只读工具列出全部工具与必填参数，供模型对齐意图；
- 工具内只做**结构化参数校验 + 稳定错误反馈**，不做文本解析。

示例映射（模型完成，非代码解析）：

| 用户说 | 模型应调用 |
| --- | --- |
| 「下周二下午三点加个评审」 | `workbench_event_create`（换算成 `start/end` 墙钟 + `timeZone`） |
| 「把那个评审改到会议室」 | `workbench_event_list` 找 id → `workbench_event_update` |
| 「我有哪些待办」 | `workbench_task_list` |
| 「记一个买牛奶的待办」 | `workbench_task_upsert`（生成唯一 id） |
| 「刚才那步做了什么」 | `workbench_audit` |

## 2. UI 与 Agent 共用统一业务方法

```
UI  ─┐
     ├─→ createWorkbenchHostService.invoke(sessionId, op, payload, meta)
Agent┘        └─→ forSession(sessionId, scope).execute(op, payload, meta)
                     └─→ createWorkbenchService（WP1 起的唯一门面）
```

- **同一个** `forSession` 门面实例、`execute` 唯一入口；
- 统一参数校验 / 危险操作审批 / 审计 / 错误语义（`WorkbenchError.code`）；
- `workbench-core` 零 DSH 依赖，`apply()` 时才注入 `ctx` 与真 `defineTool`。

## 3. 创建 / 查询 / 编辑（工具层 → service 真实契约对齐）

| 工具 | op | payload（**service 真实读法**） |
| --- | --- | --- |
| `workbench_event_create` | `event.create` | `{title, allDay, start/end, timeZone, ...}` |
| `workbench_event_list` | `event.list` | `{includeDeleted}`（**只认这个字段**） |
| `workbench_event_get` | `event.get` | `{id}` |
| `workbench_event_update` | `event.update` | **`{id, patch:{...}}`** —— 平铺字段会被忽略 |
| `workbench_task_list` | `task.list` | `{}` |
| `workbench_task_upsert` | `task.upsert` | **`{task:{id,...}}`** —— `task.id` 必填非空 |
| `workbench_help` | — | 只读，列工具与参数 |
| `workbench_audit` | — | 只读，本会话审计流水 |

> 这层对齐是**实测**出来的：初版 `event.update` 平铺字段、`task.upsert`
> 平铺字段，编辑不会生效；已按 `service.js:201` / `service.js:379` 修正，
> 并有测试断言「title 真的被改」「同 id 是更新不是新增」。

## 4. Host 可信审批与参数校验

- 危险操作（`delete/bulkDelete/import/replace/rollback`）**不注册为 AI 工具**；
- 工具不读 `args.confirmed`；凭证只能来自 Host 签发的 `approvalToken`；
- `host` 模式把 `ctx.approval.request` 注入 approval-gate，
  用真字段 `toolName` + `req.agent.session`，把真词汇 `allowed-once` 映射为
  gate 的 `approved`；无 answerer / 无 open turn → `unavailable` → **fail closed**；
- 参数由真 `defineTool` 预校验（`ToolArgsError`），业务规则另在 execute 内显式校验；
- 错误只回传白名单码（`validation/not-found/conflict/confirmation-required/unsupported`），
  内部存储异常不暴露给模型。

## 5. 会话与 sessionId / scope 隔离

- sessionId **唯一来源** `exec.agent.session.id`（真实 DSH 无 `exec.sessionId`）；
- 每个 session 独立 sha256 目录；scope 作为一等字段也进入目录路径；
- 实测：session-B 看不到 session-A 的事件；events/tasks scope 各自独立；
- 审计按 sessionId 过滤，跨 session 不可见。

## 6. 错误反馈与操作审计

- 稳定 `{code,message}`；`workbench_audit` 可查本会话最近 N 条
  （seq / actor / op / scope / 错误 / payload **键名**，不记用户数据全文）；
- 审计上限 2000 条，`workbench_help` 不泄露 sessionId 原文。

## 7. 复核命令

```bash
cd /Users/sylas/Developer/dsh-workbench/workbench-core
node --test test/host-service.test.mjs
node --test test/host-tools.test.mjs        # 含 2 项真 defineTool 验证
node --test test/*.test.mjs                  # 233/233
cd .. && node scripts/r3-mutate.mjs /tmp/mut.log   # 36/36
node /tmp/real-defineTool.mjs                # 真 defineTool 接受 8 个定义
```

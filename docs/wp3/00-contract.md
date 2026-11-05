# WP3 契约底稿：DSH 真实 API（app.asar 一手源码）

来源：`/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/`（从
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 解包）。
**只记录真实契约，不臆造 API。**

## 1. 工具注册：`ctx.tools.register(defineTool(...))`

包：`@deepseek-ai/dsh-tools`

- `defineTool(options)` — `lib/index.js:838`
  - `options.name` / `description` / `parameters`（schema DSL：`{type,required,description}`）
  - `options.output` **必须**是 `{ schema, render(args,value), presentationMeta? }`，
    否则 `register` 抛 `TypeError`（`lib/index.js:2974-2978`）
  - `options.execute(args, exec)`：模型参数在调用前由 `validateJsonSchemaValue`
    校验，违规抛 `ToolArgsError`（`lib/index.js:866-872`）
  - 可选：`timeoutMs`（正有限数）、`deferLoading`、`presentCall`、`presentResult`、
    `finalizeContent`、`projectContent`、`isConcurrencySafe`
- `ctx.tools.register(definition)` — `lib/index.js:2974`
  - 返回**精确 disposer**（`layers.effect`），插件卸载时反注册
  - `name === 'run_code'` 保留，禁止注册
  - 全局或调用方 agent scope；scoped 工具 shadow 全局
- `exec` 对象（真实字段，`lib/index.js:3239-3254`）：
  `token`, `callId`, `rootCallId`, `name`, `signal`, `agent`, `parent`, `schema`,
  `deferContext()`, `concludeTurn()`, `arguments`（deepFreeze）
  - **没有 `exec.sessionId`**。真实 tool 通过 `exec.agent.session.id` 拿 sessionId
    （见 `dsh-tool-schedule/lib/index.js:540,562,594,636`）
  - `exec.agent === undefined` → 无调用方 Agent，须返回 internal error

## 2. 插件挂载范式（照抄 `dsh-tool-schedule`）

`dsh-tool-schedule/lib/index.js`：

```js
const name = "tool-schedule"
const inject = ["tools"]                      // 声明依赖
function apply(ctx) {
  ctx.inject(["schedule"], (scheduleCtx) => { // 等 Host service 就绪
    registerScheduleTools(scheduleCtx)        // 在解析到 service 的 scope 注册
  })
}
export { apply, inject, name }
```

- 工具主体用 `ctx.tools.register(defineTool({...}))`
- `async execute(args, exec)`：
  1. `const agent = exec.agent; if (!agent) return internalError()`
  2. 拒绝委派子 agent（`delegationDepthOf(agent) !== 0` → `subagent_session`）
  3. 显式参数校验（即便 schema 已校验，业务规则另做）
  4. `if (exec.signal.aborted) return ...`
  5. `try { ... await ctx.<service>.method(...) } catch (error) { return operationError(error) }`
  6. 只返回**声明过的 output schema 的 JSON 值**，错误用稳定 `{code,message}`，
     不把内部存储异常暴露给模型
- `presentCall` / `presentResult`：给 UI 的展示元数据（`card:"generic"` 等）

## 3. Host 可信审批：`@deepseek-ai/dsh-user-approval`

- `policy: ask`（默认）/ `never`；`ask` 交给 `approval/request` waterfall 的
  answerers；**无 answerer 或失败 → `unavailable`，fail closed**
- `request(req)` 命名 **agent / toolName / callId / reason** + abort signal；
  **必须在 open turn 内**（`hasOpenTurn(session)` 读 `turn/start` 未闭合），
  否则抛出且不写审计。
  **返回词汇**：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，
  **只有 `'allowed-once'` 是授予**（没有 `'approved'`）。
  见 `dsh-user-approval/lib/index.js:29-34, 128-143`；
  `dsh-tools/lib/index.js:3553` 的 `serviceAsk` 用 `toolName: exec.name` 与
  `agent: exec.agent` 调用它。
- 每次请求与结果写入**请求会话的审计日志**；模型看不到审批 UI 与审计事件
- `setPolicy(agent, policy)` / `setApprovalPolicy(session, policy)`
- 工具流水线的 `tools/pre-execute` → `ask` → `serviceAsk` 即走此 seam
  （`dsh-tools/lib/index.js:3313-3320`）

→ WP3 的写工具应让**Host 的 ask 策略**生效，而不是在工具内部用布尔值
`confirmed` 自造审批（那正是 WP2 修掉的旁路）。

## 4. 会话与 sessionId / scope 隔离

- sessionId 唯一来源：`exec.agent.session.id`（`dsh-tool-schedule` 实证）
- `ctx.tools.restrict(filter)` / `ctx.tools.get(name, scope)` / `ctx.tools.schemas(scope)`
  —— 工具可见性按 scope 收敛（`dsh-tools/README.md`「Restrict tools per agent」）
- Service 侧沿用既有 `hostMap` 的 `sessionId` 与 `scope` 一等字段隔离
  （WP2 已验证），WP3 不得用 key 前缀猜归属

## 5. 现有 `workbench-core/src/service.js` 的定位

`createWorkbenchService({dataDir, approvalMode})` 已提供：
- `execute(op, payload, meta)` —— **UI 与 Agent 共用的唯一入口**
- `listOps()`、`DANGEROUS_OPS`、`WRITE_OPS`
- `deny` 模式在主入口拦截全部写操作（R3-7）
- 审计：所有写操作落 audit

WP3 **复用**这个门面，不重造业务方法；新增的是「Host Service 适配 +
工具注册 + 会话绑定 + 审计落到 Host」。

## 6. 不能用的东西（红线）

- ❌ 不注册 `run_code`
- ❌ 不用 `exec.sessionId`（不存在）
- ❌ 不在工具内用 `confirmed: true` 之类自造布尔审批
- ❌ 不用 MemoryAdapter / contract-stub 冒充真实 Host 测试
- ❌ 不写 `~/.dsh/profiles`、不改用户数据、不 push

## 复核命令

```bash
FULL=/tmp/dsh-asar-full/dsh/node_modules
grep -n "register(definition)" $FULL/@deepseek-ai/dsh-tools/lib/index.js
sed -n '3239,3254p' $FULL/@deepseek-ai/dsh-tools/lib/index.js
sed -n '496,545p' $FULL/@deepseek-ai/dsh-tool-schedule/lib/index.js
sed -n '30,60p' $FULL/@deepseek-ai/dsh-user-approval/README.md
```

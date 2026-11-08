/**
 * **WP3 AI 工具定义**（`ctx.tools.register`）。
 *
 * ## 为什么是「纯工厂」
 *
 * `workbench-core` 保持零 DSH 依赖（WP1 起的硬约束）。所以本模块**不 import**
 * `defineTool` / `ctx`，而是导出「工具描述 + execute 逻辑」的工厂：
 *
 *   - `createWorkbenchToolDefinitions({ service })` → 可直接喂给真 `defineTool`
 *     的 options 数组，也能在纯 Node 下直接调 `execute` 做单元测试。
 *   - `applyWorkbenchTools(ctx, { defineTool, service })` → 由 **真实 Host**
 *     注入 `defineTool` 并 `ctx.tools.register(...)`，返回精确 disposer 数组。
 *
 * ## 真实契约（app.asar 一手源码）
 *
 * - `defineTool(options)` — `dsh-tools/lib/index.js:838`
 * - `ctx.tools.register(definition)` — `dsh-tools/lib/index.js:2974`，返回 disposer
 * - `exec.agent.session.id` 是 **唯一** sessionId 来源（`dsh-tool-schedule` 实证）
 * - `exec.agent === undefined` → 拒绝（无调用方 Agent）
 * - `output` 必须 `{schema, render}`；schema 用 `oneOf` 包成功值 + 稳定错误
 * - 参数由 `validateJsonSchemaValue` 预校验；业务规则另在 execute 内显式校验
 * - 只返回声明过的 JSON 值，**不把内部异常暴露给模型**
 *
 * ## 安全
 *
 * - 写工具不读 `args.confirmed`；凭证只能来自 Host 签发的 `approvalToken`
 * - 所有调用经 `service.invoke(sessionId, op, payload, meta)` —— UI 与 Agent
 *   共用同一个业务门面
 * - 审计由 Host Service 层统一记录
 */

/** 稳定错误码（模型可见，不泄露内部存储异常）。 */
export const TOOL_ERRORS = Object.freeze({
  noAgent: Object.freeze({ ok: false, code: 'internal_error', message: 'The workbench operation failed: no calling Agent.' }),
  aborted: Object.freeze({ ok: false, code: 'internal_error', message: 'The workbench operation was cancelled.' }),
  internal: Object.freeze({ ok: false, code: 'internal_error', message: 'The workbench operation failed.' }),
})

/** output.render：真实 `dsh-tool-schedule` 用的是同一形状。 */
export function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 稳定的错误对象（只暴露 WorkbenchError.code + 白名单消息）。 */
function operationError(error) {
  const code = error?.code
  if (typeof code !== 'string' || code === '') return TOOL_ERRORS.internal
  // 参数/校验/冲突/未找到/需审批：这些是**可预期**的业务错误，可回传模型
  const EXPOSED = new Set([
    'validation', 'not-found', 'conflict', 'confirmation-required', 'unsupported',
  ])
  if (!EXPOSED.has(code)) return TOOL_ERRORS.internal
  return { ok: false, code, message: String(error?.message ?? code) }
}

/**
 * 统一的错误 schema（所有工具共用）。
 *
 * **BLOCKER-1 修复**：`additionalProperties: false` + `ok: {const:false}` 让
 * 错误对象**不会**同时命中成功分支。真 `validateJsonSchemaValue` 的 oneOf
 * 要求「恰好一支」；原 RESULT_SCHEMA 是 `additionalProperties:true`，错误对象
 * 会同时匹配两支 → 真 ToolRuntime 抛 ToolOutputError，模型拿不到稳定错误。
 * 对照真 `dsh-tool-schedule/lib/index.js:158-190`，它用 const 让互斥成立。
 */
const ERROR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: false, required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
})

/** 成功结果：必须有 ok:true，与 ERROR_SCHEMA 的 ok:false 互斥。 */
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', const: true, required: true },
    op: { type: 'string', required: true },
    // result 形态各 op 不同（数组/对象/标量），由 additionalProperties:true 承载；
    // 不声明其 schema —— 真 DSL 的 json 属性对数组/对象会要求 lossless，反而误判。
  },
})

const OUTPUT_SCHEMA = Object.freeze({
  oneOf: [RESULT_SCHEMA, ERROR_SCHEMA],
})

/**
 * 工具执行骨架：统一处理 agent / abort / 业务调用 / 错误。
 * @param {{ service: { invoke: Function }, exec: object, args: object, op: string,
 *           payload: (args: object) => object, meta?: object }} input
 */
async function runTool({ service, exec, args, op, payload, meta = {} }) {
  const agent = exec?.agent
  if (agent === undefined) return TOOL_ERRORS.noAgent
  if (exec?.signal?.aborted === true) return TOOL_ERRORS.aborted

  const sessionId = agent.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return TOOL_ERRORS.noAgent

  try {
    /**
     * 少数工具要**按参数决定调用哪个 op**（导入/导出按 format 分流）。
     * payload 返回 `{ op, payload }` 时以它为准；否则用定义上的 op。
     * 这只改变「调哪个方法」，不改变审批：危险 op 仍然要 Host 签发的凭证。
     */
    const resolved = payload(args)
    const isRouted = resolved !== null && typeof resolved === 'object'
      && typeof resolved.op === 'string'
    const opName = isRouted ? resolved.op : op
    const opPayload = isRouted ? resolved.payload : resolved
    if (opName === null || opName === undefined) {
      return operationError(new Error(`未知的导入/导出格式：${String(args.format)}`))
    }
    const result = service.invoke(sessionId, opName, opPayload, {
      ...meta,
      actor: 'agent-tool',
      // 真 ApprovalService.request 需要 req.agent.session；
      // sessionId 与 agent 都只取自 exec（唯一可信来源）
      agent,
      // 凭证只可能来自 Host；工具绝不从 args 里读 confirmed
      approvalToken: meta.approvalToken,
    })
    // 统一包装成 object；service 的原始返回值放进 `result`，避免 schema 歧义
    return { ok: true, op: opName, result }
  } catch (error) {
    return operationError(error)
  }
}

/** 非危险 op 的通用工具工厂（读 / 创建 / 更新）。 */
function simpleTool({ name, description, parameters, op, payload }) {
  return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      // service 通过闭包注入（见 createWorkbenchToolDefinitions）
      return runTool({ service: this.service, exec, args, op, payload })
    },
  }
}

/**
 * 生成所有工具定义（纯对象，未绑定 service）。
 * @param {{ service: { invoke: Function } }} deps
 */
export function createWorkbenchToolDefinitions(deps = {}) {
  const { service } = deps
  if (typeof service?.invoke !== 'function') {
    throw new TypeError('createWorkbenchToolDefinitions 需要带 invoke 的 service')
  }

  const definitions = [
    // ---- 查询 ----
    simpleTool({
      name: 'workbench_event_list',
      description: 'List calendar events in this session/scope. Set includeDeleted=true to include soft-deleted events.',
      parameters: {
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted events (default false).' },
      },
      op: 'event.list',
      payload: (args) => ({ includeDeleted: args.includeDeleted === true }),
    }),
    simpleTool({
      name: 'workbench_event_get',
      description: 'Get one calendar event by exact id.',
      parameters: { id: { type: 'string', required: true, description: 'Exact event id.' } },
      op: 'event.get',
      payload: (args) => ({ id: args.id }),
    }),
    simpleTool({
      name: 'workbench_task_list',
      description: 'List todos in this session/scope.',
      parameters: {
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted todos (default false).' },
      },
      op: 'task.list',
      // 与 event.list 对称：能透传 includeDeleted，AI 才能看到已删项
      payload: (args) => ({ includeDeleted: args.includeDeleted === true }),
    }),
    // ---- 创建 / 编辑 ----
    simpleTool({
      name: 'workbench_event_create',
      description: 'Create a calendar event. For all-day events set allDay=true and startDate (YYYY-MM-DD); otherwise set allDay=false, start/end wall clock and timeZone.',
      parameters: {
        title: { type: 'string', required: true, description: 'Event title.' },
        allDay: { type: 'boolean', required: true, description: 'Whether this is an all-day event.' },
        startDate: { type: 'string', description: 'YYYY-MM-DD, required when allDay=true.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD, optional for all-day.' },
        start: { type: 'string', description: 'Wall clock YYYY-MM-DDTHH:mm:ss, required when allDay=false.' },
        end: { type: 'string', description: 'Wall clock, optional.' },
        timeZone: { type: 'string', description: 'IANA time zone, e.g. Asia/Shanghai.' },
        description: { type: 'string', description: 'Optional description.' },
        location: { type: 'string', description: 'Optional location.' },
      },
      op: 'event.create',
      payload: (args) => ({ ...args }),
    }),
    simpleTool({
      name: 'workbench_event_update',
      description: 'Edit an existing calendar event by id. Supply only the fields to change.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact event id.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        location: { type: 'string', description: 'New location.' },
      },
      op: 'event.update',
      // 真实 service 契约：event.update 读 payload.patch，平铺字段会被忽略
      payload: (args) => {
        const { id, ...patch } = args
        return { id, patch }
      },
    }),
    simpleTool({
      name: 'workbench_task_upsert',
      description: 'Create or update a todo. Always supply an id (use a fresh unique string to create).',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id; use a fresh unique string to create.' },
        title: { type: 'string', required: true, description: 'Todo title.' },
        dueAt: { type: 'string', description: 'ISO instant due time.' },
        done: { type: 'boolean', description: 'Completion flag.' },
        priority: { type: 'string', description: 'Priority: low / normal / high.' },
        status: { type: 'string', description: 'Status label, e.g. planned / doing / done.' },
        project: { type: 'string', description: 'Project/group this todo belongs to.' },
        parentId: { type: 'string', description: 'Parent todo id (keeps the parent/child relation).' },
        subtasks: { type: 'array', description: 'Subtask titles.' },
      },
      op: 'task.upsert',
      // 真实 service 契约：task.upsert 读 payload.task，且 task.id 必填非空
      // 只回传显式给出的字段：合并语义保证未给的字段不被抹掉
      payload: (args) => {
        const task = {}
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) task[k] = v
        }
        return { task }
      },
    }),
    simpleTool({
      name: 'workbench_task_reorder',
      description: 'Reorder todos by supplying the complete desired order of ids (not a move instruction). Only the order field changes.',
      parameters: {
        ids: { type: 'array', required: true, description: 'Complete desired order of todo ids.' },
        project: { type: 'string', description: 'Restrict to one project group.' },
      },
      op: 'task.reorder',
      payload: (args) => {
        const out = { ids: args.ids }
        if (args.project !== undefined) out.project = args.project
        return out
      },
    }),
    simpleTool({
      name: 'workbench_task_archive',
      description: 'Archive or unarchive todos. Archiving is not deleting: archived todos stay readable and are not destructive.',
      parameters: {
        id: { type: 'string', description: 'Single todo id.' },
        ids: { type: 'array', description: 'Multiple todo ids.' },
        archived: { type: 'boolean', description: 'true to archive (default), false to unarchive.' },
      },
      op: 'task.archive',
      payload: (args) => {
        const out = { archived: args.archived !== false }
        if (args.id !== undefined) out.id = args.id
        if (args.ids !== undefined) out.ids = args.ids
        return out
      },
    }),
    // ---- 拖拽移动（WP5）----
    simpleTool({
      name: 'workbench_event_move',
      description: 'Move an event to a new date/time. For a recurring event you MUST say whether you mean a single occurrence or the whole series; "this and future" is not supported and will be refused.',
      parameters: {
        id: { type: 'string', required: true, description: 'Event id.' },
        mode: { type: 'string', required: true, description: 'single (one occurrence only) or series (the whole recurring series).' },
        startDate: { type: 'string', description: 'New date YYYY-MM-DD for all-day events.' },
        start: { type: 'string', description: 'New wall-clock start YYYY-MM-DDTHH:mm for timed events.' },
        timeZone: { type: 'string', description: 'New IANA time zone, if changing it.' },
        occurrenceDate: { type: 'string', description: 'Required with mode=single: the date of the occurrence being moved.' },
      },
      op: 'event.move',
      payload: (args) => {
        const target = {}
        if (args.startDate !== undefined) target.startDate = args.startDate
        if (args.start !== undefined) target.start = args.start
        if (args.timeZone !== undefined) target.timeZone = args.timeZone
        const out = { id: args.id, mode: args.mode, target }
        if (args.occurrenceDate !== undefined) out.occurrenceDate = args.occurrenceDate
        return out
      },
    }),

    // ---- 导入导出（WP5）----
    simpleTool({
      name: 'workbench_import_preview',
      description: 'Preview an import without writing anything: reports added / duplicate / conflicting / unsupported items. There is no apply tool: the actual import runs only through the Workbench UI, which obtains a Host-issued approval token. Show this preview to the user and tell them to confirm in the panel.',
      parameters: {
        format: { type: 'string', required: true, description: 'ics or json.' },
        text: { type: 'string', required: true, description: 'Raw file content.' },
        defaultTimeZone: { type: 'string', description: 'Time zone for ICS entries without TZID.' },
      },
      op: null,
      payload: (args) => {
        if (args.format === 'ics') return { op: 'event.previewIcs', payload: { text: args.text, defaultTimeZone: args.defaultTimeZone } }
        if (args.format === 'json') return { op: 'snapshot.preview', payload: { text: args.text } }
        return { op: null, payload: {} }
      },
    }),
    simpleTool({
      name: 'workbench_export',
      description: 'Export everything as JSON, or events as ICS.',
      parameters: {
        format: { type: 'string', required: true, description: 'ics or json.' },
      },
      op: null,
      payload: (args) => {
        if (args.format === 'ics') return { op: 'event.exportIcs', payload: {} }
        if (args.format === 'json') return { op: 'snapshot.export', payload: {} }
        return { op: null, payload: {} }
      },
    }),

    // ---- 撤销 / 重做（WP5）----
    simpleTool({
      name: 'workbench_history_status',
      description: 'Report whether an undo or redo is available and what the next one would revert.',
      parameters: {},
      op: 'history.status',
      payload: () => ({}),
    }),
    simpleTool({
      name: 'workbench_undo',
      description: 'Undo the most recent change (yours or the user\'s). The undone change can be redone.',
      parameters: {},
      op: 'history.undo',
      payload: () => ({}),
    }),
    simpleTool({
      name: 'workbench_redo',
      description: 'Redo the most recently undone change.',
      parameters: {},
      op: 'history.redo',
      payload: () => ({}),
    }),

    // ---- 错误反馈 / 操作审计 ----
    {
      name: 'workbench_help',
      description: 'List the available workbench operations and their required parameters. Use this to map a natural-language request to the right tool.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec) {
        const agent = exec?.agent
        if (agent === undefined) return TOOL_ERRORS.noAgent
        const sessionId = agent.session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return TOOL_ERRORS.noAgent
        return {
          ok: true,
          op: 'help',
          result: {
            sessionId: '[redacted]',
            tools: createWorkbenchToolDefinitions({ service: { invoke: () => ({}) } })
              .map((d) => ({ name: d.name, description: d.description, parameters: Object.keys(d.parameters ?? {}) })),
            hint: 'Map the user request to one tool; validate required parameters; never invent an operation not listed here. WP6: AI may only produce planning PROPOSALS (workbench_plan_*) and write progress/estimate/session links/completion REQUESTS. AI can NEVER complete, delete, bulk-overwrite, or apply a proposal by itself — those require explicit user confirmation in the UI with a Host approval token.',
          },
        }
      },
    },
    {
      name: 'workbench_audit',
      description: 'Read the recent operation audit trail for this session (op, actor, scope, errors).',
      parameters: {
        limit: { type: 'number', description: 'Max rows to return (default 50, max 2000).' },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const agent = exec?.agent
        if (agent === undefined) return TOOL_ERRORS.noAgent
        const sessionId = agent.session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return TOOL_ERRORS.noAgent
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 2000) : 50
        return { ok: true, op: 'audit', result: { rows: this.service.audit({ sessionId, limit }) } }
      },
    },
    // ---- WP6：AI 智能规划与会话协作（只读提案 / 进度 / 验收申请）----
    // 红线：危险 op（proposal.apply / acceptCompletion / rejectCompletion /
    // delete / bulk / replace）**不注册为 AI 工具**，只能由 UI 在用户确认后
    // 经 commands 通道带审批 token 调用。
    simpleTool({
      name: 'workbench_plan_suggest',
      description: 'Deterministic AI planning: given a natural-language goal, a time window, and optional tasks/subtask titles, produce a structured planning PROPOSAL using REAL todo/calendar data (priority, due dates, estimated minutes, free slots, conflicts). READ-ONLY toward business data — only a pending proposal is created; nothing lands in events/tasks until the user confirms in the UI with a Host approval token. Returns decomposition, suggested schedule, conflicts, reasons and capacity stats. Use this for daily/weekly plans, task decomposition and overload detection; clarify ambiguous dates/times/targets with the user before calling.',
      parameters: {
        goal: { type: 'string', required: true, description: 'User natural-language goal or meeting notes (untrusted).' },
        windowStart: { type: 'number', required: true, description: 'Planning window start, epoch milliseconds.' },
        windowEnd: { type: 'number', required: true, description: 'Planning window end, epoch milliseconds.' },
        taskIds: { type: 'array', description: 'Existing todo ids to include in this plan.' },
        targetTitles: { type: 'array', description: 'Subtask titles to decompose into (from chat/notes).' },
        capacityMinutesPerDay: { type: 'number', description: 'Daily capacity 1..1440 (default 480).' },
        minSlotMs: { type: 'number', description: 'Min free-slot length for scheduling.' },
        bufferMs: { type: 'number', description: 'Buffer between scheduled blocks.' },
        allDayBlocks: { type: 'boolean', description: 'Treat all-day events as blocking.' },
        kind: { type: 'string', description: 'plan | decompose | schedule | mixed.' },
      },
      op: 'plan.suggest',
      payload: (args) => ({
        goal: args.goal, windowStart: args.windowStart, windowEnd: args.windowEnd,
        taskIds: args.taskIds, targetTitles: args.targetTitles,
        capacityMinutesPerDay: args.capacityMinutesPerDay,
        minSlotMs: args.minSlotMs, bufferMs: args.bufferMs,
        allDayBlocks: args.allDayBlocks, kind: args.kind,
      }),
    }),
    simpleTool({
      name: 'workbench_plan_preview',
      description: 'Generate an AI planning proposal from a natural-language goal. READ-ONLY toward business data: it only creates a pending proposal (tasks/subtasks/suggested schedule/conflicts/reasons). Nothing is written to events or tasks until the user confirms via the UI with a Host approval token. Use this to decompose complex goals, estimate priority/due dates, and suggest a daily/weekly plan.',
      parameters: {
        sourceText: { type: 'string', description: 'The user natural-language goal or meeting notes (untrusted, stored truncated).' },
        reasoning: { type: 'string', description: 'Brief explanation of the proposed arrangement (untrusted, display only).' },
        kind: { type: 'string', description: 'plan | decompose | schedule | mixed (default plan).' },
        items: { type: 'array', required: true, description: 'Structured proposal items. Each: {op: task.create|task.update|event.create, payload:{...}, targetId?, reason?}. up to 50.' },
        conflicts: { type: 'array', description: 'Known conflicts to surface (from event.conflicts).' },
      },
      op: 'proposal.preview',
      payload: (args) => ({
        sourceText: args.sourceText, reasoning: args.reasoning, kind: args.kind,
        items: args.items, conflicts: args.conflicts,
      }),
    }),
    simpleTool({
      name: 'workbench_plan_list',
      description: 'List pending planning proposals for this session/scope.',
      parameters: {},
      op: 'proposal.list',
      payload: () => ({}),
    }),
    simpleTool({
      name: 'workbench_plan_get',
      description: 'Get one planning proposal by id (including items, conflicts, reasoning, bound version).',
      parameters: { id: { type: 'string', required: true, description: 'Proposal id.' } },
      op: 'proposal.get',
      payload: (args) => ({ id: args.id }),
    }),
    simpleTool({
      name: 'workbench_plan_reject',
      description: 'Reject a pending planning proposal. Changes only the proposal status; events/tasks are never modified.',
      parameters: { id: { type: 'string', required: true, description: 'Proposal id.' } },
      op: 'proposal.reject',
      payload: (args) => ({ id: args.id }),
    }),
    simpleTool({
      name: 'workbench_task_estimate',
      description: 'Set a todo estimated duration (1..1440 integer minutes). Invalid values are rejected as a whole.',
      parameters: {
        id: { type: 'string', required: true, description: 'Todo id.' },
        estimatedMinutes: { type: 'number', required: true, description: 'Integer minutes 1..1440.' },
      },
      op: 'task.setEstimate',
      payload: (args) => ({ id: args.id, estimatedMinutes: args.estimatedMinutes }),
    }),
    simpleTool({
      name: 'workbench_task_link_session',
      description: 'Associate a todo with a DSH Agent session (clarify/decompose/execute/review/other). Used to enter the session from task details and to let an Agent read authorized task context.',
      parameters: {
        id: { type: 'string', required: true, description: 'Todo id.' },
        sessionId: { type: 'string', required: true, description: 'DSH session id to link.' },
        role: { type: 'string', description: 'clarify | decompose | execute | review | other (default other).' },
        note: { type: 'string', description: 'Optional short note (untrusted, truncated).' },
      },
      op: 'task.linkSession',
      payload: (args) => ({ id: args.id, sessionId: args.sessionId, role: args.role, note: args.note }),
    }),
    simpleTool({
      name: 'workbench_task_by_session',
      description: 'Reverse lookup: list todos linked to a given Agent session.',
      parameters: { sessionId: { type: 'string', required: true, description: 'Session id.' } },
      op: 'task.bySession',
      payload: (args) => ({ sessionId: args.sessionId }),
    }),
    simpleTool({
      name: 'workbench_task_context',
      description: 'Read the task context authorized to MY OWN Agent session. Pass your own sessionId; the Host verifies it against the calling Agent session and rejects cross-session reads. Returns linked todos with progress, completion status and recent execution log — this is how an Agent picks up the work it is associated with. Cannot read another session tasks.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Your own DSH session id (verified against the calling Agent).' },
      },
      op: 'task.context',
      payload: (args) => ({ sessionId: args.sessionId }),
    }),
    simpleTool({
      name: 'workbench_task_progress',
      description: 'Write an execution progress entry (0..99) and optional note/evidence. NEVER marks a todo done: 100 is not progress, completion requires the user acceptance flow. AI cannot complete, delete, or bulk-overwrite tasks.',
      parameters: {
        id: { type: 'string', required: true, description: 'Todo id.' },
        progress: { type: 'number', required: true, description: 'Integer 0..99.' },
        note: { type: 'string', description: 'Short progress note.' },
        evidence: { type: 'string', description: 'Short evidence reference.' },
      },
      op: 'task.writeProgress',
      payload: (args) => ({ id: args.id, progress: args.progress, note: args.note, evidence: args.evidence }),
    }),
    simpleTool({
      name: 'workbench_request_completion',
      description: 'Submit a completion acceptance REQUEST (never completes the task). The todo stays open until the user explicitly accepts in the workbench UI. Include a 2-4 sentence summary of what was done.',
      parameters: {
        id: { type: 'string', required: true, description: 'Todo id.' },
        summary: { type: 'string', required: true, description: 'Completion summary (2-4 sentences).' },
      },
      op: 'task.requestCompletion',
      payload: (args) => ({ id: args.id, summary: args.summary }),
    }),

  ]

  // 把 service 绑到每个 execute 的 this（避免闭包里持有可变引用）
  for (const def of definitions) {
    const original = def.execute
    def.execute = function boundExecute(args, exec) {
      return original.call({ service }, args, exec)
    }
  }
  return definitions
}

/**
 * **真实 Host 挂载**：用真 `defineTool` 注册全部工具。
 *
 * @param {object} ctx 真实 Host Context（须有 `ctx.tools.register`）
 * @param {{ defineTool: Function, service: { invoke: Function } }} deps
 * @returns {Array<() => void>} 精确 disposer 数组
 */
export function applyWorkbenchTools(ctx, deps = {}) {
  const { defineTool, service } = deps
  if (typeof ctx?.tools?.register !== 'function') {
    throw new TypeError('applyWorkbenchTools 需要带 tools.register 的 Host Context')
  }
  if (typeof defineTool !== 'function') {
    throw new TypeError('applyWorkbenchTools 需要真实 defineTool')
  }
  const disposers = []
  for (const def of createWorkbenchToolDefinitions({ service })) {
    disposers.push(ctx.tools.register(defineTool(def)))
  }
  return disposers
}

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
  noAgent: Object.freeze({ code: 'internal_error', message: 'The workbench operation failed: no calling Agent.' }),
  aborted: Object.freeze({ code: 'internal_error', message: 'The workbench operation was cancelled.' }),
  internal: Object.freeze({ code: 'internal_error', message: 'The workbench operation failed.' }),
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
  return { code, message: String(error?.message ?? code) }
}

/** 统一的错误 schema（所有工具共用）。 */
const ERROR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
})

/** 任意 JSON 结果（op 返回值形态各不同，用宽松 object 承载）。 */
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
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
    const result = service.invoke(sessionId, op, payload(args), {
      ...meta,
      actor: 'agent-tool',
      // 凭证只可能来自 Host；工具绝不从 args 里读 confirmed
      approvalToken: meta.approvalToken,
    })
    // 统一包装成 object；service 的原始返回值放进 `result`，避免 schema 歧义
    return { ok: true, op, result }
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
      parameters: {},
      op: 'task.list',
      payload: () => ({}),
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
      },
      op: 'task.upsert',
      // 真实 service 契约：task.upsert 读 payload.task，且 task.id 必填非空
      payload: (args) => ({ task: { ...args } }),
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
            hint: 'Map the user request to one tool; validate required parameters; never invent an operation not listed here.',
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

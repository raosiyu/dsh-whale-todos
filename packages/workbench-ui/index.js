/**
 * WP4 Host half.
 *
 * 两件事（都只做一次，UI 与 AI 工具共用）：
 *  1. `ctx.provide('workbench', service)` — 挂 WP3 的 Host Service，
 *     它是 Event/Task 的**唯一**数据源（本地文件存储，非假数据）。
 *  2. `ctx.commands.register({name:'workbench', handler})` — Client 通过
 *     真 `ctx.remote.commands.execute(sessionId, line, attachments)` 调用；
 *     handler 解析结构化请求后转调 `service.invoke(...)`，与 AI 工具同一个方法。
 *
 * 真契约来源（app.asar 一手源码）：
 *  - `dsh-cmdline/lib/index.js:29` 的 `ctx.provide(name, value)`
 *  - `dsh-command-compact/lib/index.js:93-98` 的 `ctx.commands.register`
 *  - `dsh-commands/lib/index.js:327-395` 的 `execute(agent,line,...)`：
 *      handler 收**单个** `invocation = {commandId, agent, rawInput, attachments, signal}`；
 *      `agent.session.id` 是 sessionId；`rawInput` 是 `/workbench ` 之后的文本；
 *      返回 `{kind:'success'|'error', text}`（由 normalizeResult 规范化）。
 *  - `dsh-client-ui-commands/lib/client.js:1718` 的 `ctx.remote.commands.execute`
 *  - `references/user-actions.md:7-11`（一次实现、两个调用者）
 *
 * 红线：不写正式 DSH profile、不改用户数据、不 push。`rootDir` 必须由
 * 配置显式给出；空字符串时**拒绝启动**，绝不悄悄落到 ~/.dsh。
 */

import { createWorkbenchHostService } from '../../workbench-core/src/index.js'

export const name = 'workbench-ui'
export const inject = ['commands']

/**
 * 编码：`/workbench <JSON>`。
 * `parseCommand(line)`（dsh-commands）会把 `/workbench ` 之后的内容放进
 * `invocation.rawInput`。JSON 形状：
 *   { op, payload?, scope?, approvalToken?, agent? }
 * sessionId **只**取自 `invocation.agent.session.id`（不信 payload 里的
 * sessionId，避免越权改别人的数据）。
 */
export function parseWorkbenchRequest(rawInput) {
  if (typeof rawInput !== 'string') {
    return { error: { code: 'invalid_request', message: 'rawInput must be a string' } }
  }
  const text = rawInput.trim()
  if (text === '') return { error: { code: 'invalid_request', message: 'empty workbench request' } }
  let req
  try {
    req = JSON.parse(text)
  } catch {
    return { error: { code: 'invalid_request', message: 'workbench request must be valid JSON' } }
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return { error: { code: 'invalid_request', message: 'workbench request must be an object' } }
  }
  if (typeof req.op !== 'string' || req.op === '') {
    return { error: { code: 'invalid_request', message: 'op is required' } }
  }
  return { req }
}

/** 把 service.invoke 的结果/错误编码成真 command 的 `{kind,text}` 返回。 */
function encodeResult(outcome) {
  if (outcome.ok !== true) {
    // 带 value（如有）：审批「未批准」是明确业务状态，不能只回一个空错误，
    // 否则 UI 无法区分「审批被拒」与「命令失败」，违反「错误明确、不静默」。
    return {
      kind: 'error',
      text: JSON.stringify({
        ok: false,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.value !== undefined ? { value: outcome.value } : {}),
        ...(outcome.op !== undefined ? { op: outcome.op } : {}),
      }),
    }
  }
  return {
    kind: 'success',
    text: JSON.stringify({ ok: true, value: outcome.value, op: outcome.op }),
  }
}

export function apply(ctx, config = {}) {
  const rootDir = config.rootDir
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new Error('workbench-ui requires config.rootDir (an isolated data directory); refusing to guess a user-data path')
  }

  // `approval` 是可选 Host 服务：用 ctx.get 读取，避免「cannot get property
  // without inject」在隔离 profile 里让整个插件无法激活。
  // 缺失时 createWorkbenchHostService 会 fail-closed（危险操作拿不到 token），
  // 与 dsh-user-approval 的 'unavailable' 语义一致。
  const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
  const service = createWorkbenchHostService({
    rootDir,
    mode: 'host',
    requestApproval: approval?.request,
  })

  // 唯一数据源：UI 与 AI 工具都从这里读
  ctx.provide('workbench', service)

  const handler = async (invocation) => {
    const parsed = parseWorkbenchRequest(invocation.rawInput)
    if (parsed.error !== undefined) {
      return { kind: 'error', text: JSON.stringify({ ok: false, error: parsed.error }) }
    }

    // sessionId 唯一可信来源：调用方 Agent 的 Session
    const sessionId = invocation.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { kind: 'error', text: JSON.stringify({ ok: false, error: { code: 'no_session', message: 'no calling session' } }) }
    }
    if (invocation.signal?.aborted === true) {
      return { kind: 'error', text: JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'request cancelled' } }) }
    }

    const { op, payload = {}, scope = '', approvalToken, agent } = parsed.req
    try {
      // 删除前的真 Host 审批：只走 service.askApproval（token 由真
      // ApprovalService 签发），绝不读 payload 里的 confirmed 布尔。
      if (op === 'requestApproval') {
        const target = payload.target ?? payload.id ?? ''
        const approval = await service.askApproval(
          sessionId,
          payload.approvalOp ?? payload.op ?? 'event.delete',
          { target, summary: payload.summary ?? `Delete ${target}` },
          agent ?? invocation.agent,
        )
        return encodeResult({ ok: approval.approved === true, value: approval, op })
      }
      const value = service.invoke(sessionId, op, payload, {
        scope,
        approvalToken,
        actor: 'ui',
        ...(agent !== undefined ? { agent } : {}),
      })
      return encodeResult({ ok: true, value, op })
    } catch (error) {
      return encodeResult({
        ok: false,
        error: {
          code: error?.code ?? 'internal_error',
          message: String(error?.message ?? error),
        },
      })
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: '@local/dsh-workbench-ui/workbench',
      name: 'workbench',
      description: 'Workbench calendar and todo operations (structured JSON)',
      input: { hint: '<json>' },
      recordInput: false,
      handler,
    })
  }, 'workbench-ui: command registration')
}

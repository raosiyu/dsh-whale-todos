/**
 * Client → Host 调用的**唯一**实现（浏览器与 Node 共用）。
 *
 * ## 为什么独立成模块
 *
 * `client.js` 是浏览器模块（依赖 `window.__ModuleLoader__`），Node 里无法 import，
 * 于是测试只能「复刻」一份解码逻辑——上一轮复审实锤：把 client.js 的 callHost
 * 退回旧扁平解码时，复刻版测试仍 12/12 全绿，真 bug 复活而无人报警。
 *
 * 把这段纯逻辑抽到这里，**只有一份实现**：
 *  - client.js import 它渲染界面
 *  - 测试 import 它验证真行为
 *
 * ## 真 Remote 信封（最终 Review 实锤）
 *
 * `ctx.remote.commands.execute(sessionId, line, attachments)` 返回：
 *   { ok: true, value: { commandId, result: { kind: 'success'|'error', text } } }
 * 证据：dsh-client-ui-commands/lib/client.js:1718-1724 访问 `result.value.result`；
 *  dsh-commands/lib/typert.remote-client.js 的 commands/execute result schema；
 *  dsh-api-gateway encodeRpcResult 原样透传 `{ok:true,value:<原样>}`。
 *
 * 旧实现把 `result.value` 当业务 JSON 字符串 → 真形状下它是对象 →
 * UI 静默空列表、命令级 error 被吞。
 */

/**
 * 调用真 commands.execute 并解码出业务结果。
 *
 * @param {{ remote: { commands: { execute: Function } } }} ctx
 * @param {string} sessionId 调用方会话（唯一可信来源）
 * @param {{ op: string, payload?: object, scope?: string, approvalToken?: string }} req
 * @returns {Promise<{ ok: boolean, value?: unknown, error?: { code: string, message: string } }>}
 */
export async function callHost(ctx, sessionId, req) {
  const line = `/workbench ${JSON.stringify(req)}`
  const result = await ctx.remote.commands.execute(sessionId, line, [])
  if (result === undefined || result === null) {
    return { ok: false, error: { code: 'no_result', message: 'command returned no result' } }
  }
  if (result.ok === false) {
    return { ok: false, error: result.error ?? { code: 'command_failed', message: 'command failed' } }
  }
  const envelope = result.value
  const command = envelope !== null && typeof envelope === 'object' ? envelope.result : undefined
  const text = command !== null && typeof command === 'object' && typeof command.text === 'string'
    ? command.text
    : (typeof envelope === 'string' ? envelope : undefined)
  if (typeof text === 'string' && text !== '') {
    try {
      const decoded = JSON.parse(text)
      if (decoded !== null && typeof decoded === 'object') return decoded
    } catch { /* 非 JSON 文本按原样返回 */ }
  }
  // 命令级 error kind 也必须有明确出口，不能静默当成成功
  if (command?.kind === 'error') {
    return { ok: false, error: { code: 'command_error', message: text ?? 'command failed' } }
  }
  return { ok: true, value: text }
}

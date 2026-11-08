/**
 * WP6 终审 · 探针 9：补最后几处决定性验证
 *  (A) AI 能否调用 workbench_undo 撤销用户的操作（数据回退）
 *  (B) 同一提案重复 apply 是否重复创建
 *  (C) AI 能否删除/批量覆盖事件
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const core = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createWorkbenchHostService, createWorkbenchToolDefinitions } = core

let pass = 0; let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const tryCall = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, code: e?.code, message: e?.message }
  }
}
const W0 = Date.parse('2026-11-09T00:00:00Z'); const W1 = W0 + 7 * 86400000

const rootDir = mkdtempSync(join(tmpdir(), 'wp6-fr9-'))
const host = createWorkbenchHostService({ rootDir, mode: 'isolated', allowIsolated: true })
const ex = (sid, op, payload, meta = {}) => host.invoke(sid, op, payload, { actor: 'ui', ...meta })
const defs = createWorkbenchToolDefinitions({ service: host })
const call = async (name, args, sid) => {
  const d = defs.find((x) => x.name === name)
  return d.execute.call({ service: host }, args, { agent: { session: { id: sid } } })
}
const S = 'session-shared'

console.log('='.repeat(72))
console.log('A · AI 能否撤销用户的操作')
console.log('='.repeat(72))
{
  ex(S, 'task.upsert', { task: { id: 'u1', title: '用户亲手建的任务' } })
  const before = ex(S, 'task.list', {}).map((t) => t.id)
  console.log('  用户操作后任务：', before.join(','))
  const r = await call('workbench_undo', {}, S)
  console.log('  workbench_undo(AI 调用) =>', JSON.stringify(r).slice(0, 180))
  const after = ex(S, 'task.list', {}).map((t) => t.id)
  check('A1 AI 无法撤销用户的操作', after.includes('u1'),
    `撤销后任务=${after.join(',') || '空'}（用户建的任务被 AI 撤掉=${!after.includes('u1')}）`)

  // redo 同样暴露
  check('A2 AI 工具面同时暴露 workbench_redo',
    defs.some((d) => d.name === 'workbench_redo'))
}

console.log('')
console.log('='.repeat(72))
console.log('B · 同一提案重复 apply')
console.log('='.repeat(72))
{
  const p = ex(S, 'proposal.preview', { items: [{ op: 'task.create', payload: { title: '幂等验证' } }] }).proposal
  const t1 = await host.forSession(S).requestApproval('proposal.apply', { target: p.id })
  const r1 = tryCall(() => ex(S, 'proposal.apply', { id: p.id }, { approvalToken: t1.token }))
  check('B1 首次落地成功', r1.ok === true, r1.ok ? `created=${r1.value.created}` : r1.code)
  const t2 = await host.forSession(S).requestApproval('proposal.apply', { target: p.id })
  const r2 = tryCall(() => ex(S, 'proposal.apply', { id: p.id }, { approvalToken: t2.token }))
  check('B2 二次 apply 被拒（conflict）', r2.ok === false && r2.code === 'conflict', String(r2.code))
  const dup = ex(S, 'task.list', {}).filter((t) => t.title === '幂等验证')
  check('B3 只创建 1 条（不重复创建）', dup.length === 1, `${dup.length} 条`)

  // 同一 token 重放
  const t3 = await host.forSession(S).requestApproval('proposal.apply', { target: p.id })
  const r3 = tryCall(() => ex(S, 'proposal.apply', { id: p.id }, { approvalToken: t3.token }))
  const r4 = tryCall(() => ex(S, 'proposal.apply', { id: p.id }, { approvalToken: t3.token }))
  check('B4 token 一次性（重放被拒）', r3.ok === false && r4.ok === false,
    `第一次=${r3.ok ? 'ok' : r3.code}，重放=${r4.ok ? 'ok' : r4.code}`)
}

console.log('')
console.log('='.repeat(72))
console.log('C · AI 能否删除 / 批量覆盖事件')
console.log('='.repeat(72))
{
  ex(S, 'event.create', {
    title: '用户事件', allDay: false,
    start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00', timeZone: 'Asia/Shanghai',
  })
  const ev = ex(S, 'event.list', {})[0]
  const delRes = tryCall(() => ex(S, 'event.delete', { id: ev.id, confirmed: true }))
  check('C1 事件删除需要审批 token（AI 不能删）',
    delRes.ok === false && delRes.code === 'confirmation-required',
    delRes.ok ? '删除成功' : delRes.code)

  const bulk = tryCall(() => ex(S, 'event.bulkDelete', { ids: [ev.id], confirmed: true }))
  check('C2 批量删除需要审批 token', bulk.ok === false && bulk.code === 'confirmation-required',
    bulk.ok ? '批量删除成功' : bulk.code)

  const stillThere = ex(S, 'event.list', {}).some((e) => e.id === ev.id)
  check('C3 事件未被删除', stillThere)
}

console.log('')
console.log(`探针9 汇总: PASS=${pass} FAIL=${fail}`)
rmSync(rootDir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

/**
 * WP6 终审 · 探针 8：真实 Host 拓扑下「同会话 / 跨会话」分别是否可用。
 *
 * 关键事实：createWorkbenchHostService.forSession(sessionId, scope) 的 dataDir
 * = rootDir/s-<sha256(sessionId)[0:24]>[-scope]，即**按 sessionId 分目录**。
 * WP6 的提案与任务协作数据都在这套 store 里。
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
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

const rootDir = mkdtempSync(join(tmpdir(), 'wp6-fr8-'))
const host = createWorkbenchHostService({ rootDir, mode: 'isolated', allowIsolated: true })
const ex = (sid, op, payload, meta = {}) => host.invoke(sid, op, payload, { actor: 'ui', ...meta })
const defs = createWorkbenchToolDefinitions({ service: host })
const call = async (name, args, sid) => {
  const d = defs.find((x) => x.name === name)
  return d.execute.call({ service: host }, args, { agent: { session: { id: sid } } })
}

console.log('='.repeat(72))
console.log('A · 同会话（Agent 工具与 UI 面板同一 sessionId）')
console.log('='.repeat(72))
{
  const S = 'session-shared'
  // Agent 用工具生成提案（与用户面板同一会话）
  const r = await call('workbench_plan_suggest', {
    goal: '准备发布会', targetTitles: ['写稿件'], windowStart: W0, windowEnd: W1,
  }, S)
  check('A1 Agent 在同会话生成提案', r.ok === true, r.ok ? 'ok' : `${r.code}`)
  const pid = r.result?.proposal?.id ?? r.result?.proposal?.proposal?.id
  console.log('  plan_suggest 返回结构：', JSON.stringify(r).slice(0, 220))
  const list = tryCall(() => ex(S, 'proposal.list', {}))
  check('A2 同会话用户面板能看到该提案',
    list.ok && list.value.some((p) => p.id === pid),
    list.ok ? `${list.value.length} 条` : list.code)
  const tk = await host.forSession(S).requestApproval('proposal.apply', { target: pid })
  const applied = tryCall(() => ex(S, 'proposal.apply', { id: pid }, { approvalToken: tk.token }))
  check('A3 同会话用户能确认落地', applied.ok === true,
    applied.ok ? `created=${applied.value.created}` : `${applied.code}`)
  // 同会话内 Agent 读上下文
  ex(S, 'task.upsert', { task: { id: 'j1', title: '同会话任务' } })
  ex(S, 'task.linkSession', { id: 'j1', sessionId: S, role: 'execute' })
  const ctx = tryCall(() => ex(S, 'task.context', { sessionId: S }))
  check('A4 同会话 Agent 能读 task.context',
    ctx.ok && ctx.value.tasks.some((t) => t.id === 'j1'),
    ctx.ok ? `${ctx.value.tasks.length} 条` : ctx.code)
}

console.log('')
console.log('='.repeat(72))
console.log('B · 跨会话（Agent 在会话 B 跑，用户在会话 A 的面板确认）')
console.log('='.repeat(72))
{
  const A = 'session-user-A'
  const B = 'session-agent-B'
  ex(A, 'task.upsert', { task: { id: 'user-task', title: '用户的既有任务' } })

  const r = await call('workbench_plan_suggest', {
    goal: '跨会话规划', targetTitles: ['跨会话子任务'], windowStart: W0, windowEnd: W1,
  }, B)
  const pid = r.result?.proposal?.id ?? r.result?.proposal?.proposal?.id
  console.log('  B 会话生成提案 id =', String(pid))

  const aList = tryCall(() => ex(A, 'proposal.list', {}))
  const aGet = tryCall(() => ex(A, 'proposal.get', { id: pid }))
  check('B1 用户会话 A 能看到会话 B 的提案',
    aList.ok && aList.value.some((p) => p.id === pid),
    `A 侧 list=${aList.ok ? aList.value.length + ' 条' : aList.code}；get=${aGet.ok ? 'ok' : aGet.code}`)

  const tk = await host.forSession(A).requestApproval('proposal.apply', { target: pid })
  const applied = tryCall(() => ex(A, 'proposal.apply', { id: pid }, { approvalToken: tk.token }))
  check('B2 用户会话 A 能确认落地会话 B 的提案', applied.ok === true,
    applied.ok ? 'applied' : `${applied.code}: ${applied.message?.slice(0, 40)}`)

  // 用户把 A 的任务关联给 B，B 能否读到
  ex(A, 'task.linkSession', { id: 'user-task', sessionId: B, role: 'execute' })
  const bCtx = tryCall(() => ex(B, 'task.context', { sessionId: B }))
  check('B3 会话 B 的 Agent 能读到 A 关联给它的任务',
    bCtx.ok && bCtx.value.tasks.some((t) => t.id === 'user-task'),
    bCtx.ok ? `B 侧 tasks=${bCtx.value.tasks.length} 条` : bCtx.code)

  const bBy = tryCall(() => ex(B, 'task.bySession', { sessionId: B }))
  check('B4 task.bySession 在 B 侧命中', bBy.ok && bBy.value.length > 0,
    bBy.ok ? `${bBy.value.length} 条` : bBy.code)

  console.log('  实际数据目录：', readdirSync(rootDir).join(' , '))
}

console.log('')
console.log('='.repeat(72))
console.log('C · WP6-E 探针口径（单一 dataDir，多 sessionId）')
console.log('='.repeat(72))
{
  const dir = mkdtempSync(join(tmpdir(), 'wp6-fr8-bare-'))
  const svc = core.createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const e2 = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
  const p = e2('session-agent-B', 'plan.suggest', { goal: 'g', targetTitles: ['X'], windowStart: W0, windowEnd: W1 })
  const seen = e2('session-user-A', 'proposal.list', {}).some((x) => x.id === p.proposal.id)
  check('C1 裸 service（单一 dataDir）下跨会话可见', seen,
    seen ? '可见（这正是 E2E 44/44 的口径）' : '不可见')
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(`探针8 汇总: PASS=${pass} FAIL=${fail}`)
rmSync(rootDir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

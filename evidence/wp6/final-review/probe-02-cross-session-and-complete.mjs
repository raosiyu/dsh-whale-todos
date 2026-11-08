/**
 * WP6 终审 · 探针 2（修正版）：
 *  (A) AI 能否绕过人工验收直接完成 / 回退完成
 *  (B) 真实 Host 层（每 session 独立 dataDir）下，WP6-C 跨会话协作是否成立
 *  (C) 与 WP6-E 探针的裸 service 路径对比 —— 判断验收是否假绿
 *
 * 只读冻结副本，测试数据全在 mkdtemp 目录，跑完即删。
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const core = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createWorkbenchHostService, createWorkbenchService, createWorkbenchToolDefinitions } = core

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const tryCall = (fn) => {
  try { return { ok: true, value: fn() } }
  catch (e) { return { ok: false, code: e?.code, message: e?.message } }
}
const DAY = 86400000
const W0 = Date.parse('2026-11-09T00:00:00Z')
const W1 = W0 + 7 * DAY
const AGENT = 'session-agent-002'
const USER = 'session-user-002'

// ============================================================== A · 真实 Host
const rootDir = mkdtempSync(join(tmpdir(), 'wp6-fr2-'))
const host = createWorkbenchHostService({ rootDir, mode: 'isolated', allowIsolated: true })
const exH = (sid, op, payload, meta = {}) => host.invoke(sid, op, payload, { actor: 'ui', ...meta })
const defs = createWorkbenchToolDefinitions({ service: host })
const callH = async (name, args, sid) => {
  const d = defs.find((x) => x.name === name)
  return d.execute.call({ service: host }, args, { agent: { session: { id: sid } } })
}

console.log('='.repeat(72))
console.log('A · AI 能否绕过人工验收（真实 Host 层，同一会话）')
console.log('='.repeat(72))
{
  const S = USER
  exH(S, 'task.upsert', { task: { id: 'k1', title: '需要人工验收的任务' } })
  await callH('workbench_request_completion', { id: 'k1', summary: '我做完了' }, S)
  check('A1 requestCompletion 后 done 仍为 false',
    exH(S, 'task.list', {}).find((t) => t.id === 'k1').done !== true)

  const r = await callH('workbench_task_upsert', { id: 'k1', title: '需要人工验收的任务', done: true }, S)
  const row = exH(S, 'task.list', {}).find((t) => t.id === 'k1')
  check('A2 AI 无法用 workbench_task_upsert 直接置 done', row.done !== true,
    `工具返回 done=${String(r?.result?.task?.done)}，库中 done=${String(row.done)}`)
  check('A3 完成未经过用户验收',
    row.completion?.status !== 'accepted', `completion.status=${String(row.completion?.status)}`)

  exH(S, 'task.upsert', { task: { id: 'k2', title: '已验收任务' } })
  exH(S, 'task.requestCompletion', { id: 'k2', summary: '完成' })
  exH(S, 'task.acceptCompletion', { id: 'k2' })
  const doneAfter = exH(S, 'task.list', {}).find((t) => t.id === 'k2').done
  await callH('workbench_task_upsert', { id: 'k2', title: '已验收任务', done: false }, S)
  const reopened = exH(S, 'task.list', {}).find((t) => t.id === 'k2').done
  check('A4 AI 无法把用户已验收的任务改回未完成', reopened === true,
    `验收后 done=${String(doneAfter)}，AI 改后 done=${String(reopened)}`)

  check('A5 AI 工具面含 workbench_undo（可撤销用户操作）',
    defs.some((d) => d.name === 'workbench_undo'))

  // AI 是否能靠 task.upsert 批量覆盖他人任务字段（title/dueAt/project）
  exH(S, 'task.upsert', { task: { id: 'k3', title: '用户标题', priority: 'high' } })
  await callH('workbench_task_upsert', { id: 'k3', title: '被 AI 改名' }, S)
  const t3 = exH(S, 'task.list', {}).find((t) => t.id === 'k3')
  check('A6 AI 能直接改用户任务标题（无需审批）', t3.title === '用户标题',
    `实际 title=${t3.title}`)
}

// ============================================================== B · 跨会话（真实 Host）
console.log('')
console.log('='.repeat(72))
console.log('B · 真实 Host 层跨会话协作（WP6-C 主路径）')
console.log('='.repeat(72))
{
  console.log('  数据目录：', readdirSync(rootDir).join(' , '))
  const plan = exH(AGENT, 'plan.suggest', {
    goal: '跨会话协作验证', targetTitles: ['写稿件'], windowStart: W0, windowEnd: W1,
  })
  const pid = plan.proposal.id
  const uList = tryCall(() => exH(USER, 'proposal.list', {}))
  const uGet = tryCall(() => exH(USER, 'proposal.get', { id: pid }))
  check('B1 用户会话能看到 Agent 生成的提案',
    uList.ok && uList.value.some((p) => p.id === pid),
    `用户侧 list=${uList.ok ? uList.value.length + ' 条' : uList.code}；get=${uGet.ok ? 'ok' : uGet.code}`)

  const tok = await host.forSession(USER).requestApproval('proposal.apply', { target: pid })
  const applied = tryCall(() => exH(USER, 'proposal.apply', { id: pid }, { approvalToken: tok.token }))
  check('B2 用户能确认落地 Agent 的提案', applied.ok === true,
    applied.ok ? 'applied' : `${applied.code}: ${applied.message}`)

  const link = tryCall(() => exH(USER, 'task.linkSession', { id: 'x1', sessionId: AGENT, role: 'execute' }))
  exH(USER, 'task.upsert', { task: { id: 'x1', title: '共享任务' } })
  tryCall(() => exH(USER, 'task.linkSession', { id: 'x1', sessionId: AGENT, role: 'execute' }))
  const ctxRes = tryCall(() => exH(AGENT, 'task.context', { sessionId: AGENT }))
  const ctxTasks = ctxRes.ok ? ctxRes.value.tasks : []
  check('B3 Agent 用 task.context 读到自己被关联的任务',
    ctxTasks.some((t) => t.id === 'x1'),
    `Agent 侧 tasks=${ctxTasks.length} 条`)

  const byS = tryCall(() => exH(AGENT, 'task.bySession', { sessionId: AGENT }))
  check('B4 task.bySession 反查命中', byS.ok && byS.value.some((t) => t.id === 'x1'),
    byS.ok ? `${byS.value.length} 条` : byS.code)

  const prog = tryCall(() => exH(AGENT, 'task.writeProgress', { id: 'x1', progress: 40, note: '进行中' }))
  check('B5 Agent 能对关联任务回写进度', prog.ok === true,
    prog.ok ? 'ok' : `${prog.code}: ${prog.message}`)
}

// ============================================================== C · 裸 service 对照
console.log('')
console.log('='.repeat(72))
console.log('C · WP6-E 探针所用的裸 service 路径（单一 dataDir）')
console.log('='.repeat(72))
{
  const dir = mkdtempSync(join(tmpdir(), 'wp6-fr2-bare-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
  const plan = ex(AGENT, 'plan.suggest', { goal: 'x', targetTitles: ['A'], windowStart: W0, windowEnd: W1 })
  const pid = plan.proposal.id
  const seen = ex(USER, 'proposal.list', {}).some((p) => p.id === pid)
  const tok = await svc.requestApproval('proposal.apply', { target: pid })
  const applied = tryCall(() => ex(USER, 'proposal.apply', { id: pid }, { approvalToken: tok.token }))
  ex(USER, 'task.upsert', { task: { id: 'x1', title: '共享任务' } })
  ex(USER, 'task.linkSession', { id: 'x1', sessionId: AGENT, role: 'execute' })
  const ctx = ex(AGENT, 'task.context', { sessionId: AGENT })
  check('C1 裸 service：用户能看到 Agent 提案', seen)
  check('C2 裸 service：用户能落地 Agent 提案', applied.ok === true)
  check('C3 裸 service：Agent 能读到关联任务上下文',
    ctx.tasks.some((t) => t.id === 'x1'), `${ctx.tasks.length} 条`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(`探针2 汇总: PASS=${pass} FAIL=${fail}`)
rmSync(rootDir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

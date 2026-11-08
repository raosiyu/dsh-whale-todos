/**
 * WP6 终审 · 探针 1：AI 工具面能否绕过「提案两阶段 / 不能自行完成 / 不能删除」。
 *
 * 走**真实 Host Service**（createWorkbenchHostService）而不是裸 service：
 * AI 工具的 execute 只拿得到 service.invoke，这正是生产路径
 * （sessionId/scope 由 invoke 注入，不从 payload 读）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const core = await import(`${FREEZE}/workbench-core/src/index.js`)
const {
  createWorkbenchHostService, createWorkbenchToolDefinitions, DANGEROUS_OPS,
} = core

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const rootDir = mkdtempSync(join(tmpdir(), 'wp6-fr1-'))
const host = createWorkbenchHostService({
  rootDir, mode: 'isolated', allowIsolated: true,
})
const ex = (sid, op, payload, meta = {}) => host.invoke(sid, op, payload, {
  actor: 'ui', ...meta,
})

const AGENT = 'session-agent-001'
const USER = 'session-user-001'

// ------------------------------------------------------------------ 1. 工具清单
const defs = createWorkbenchToolDefinitions({ service: host })
const names = defs.map((d) => d.name)
console.log(`AI 工具清单 (${names.length}):`)
for (const n of names) console.log('  - ' + n)
console.log('')

const FORBIDDEN = [
  'workbench_plan_apply', 'workbench_apply_proposal',
  'workbench_accept_completion', 'workbench_reject_completion',
  'workbench_event_delete', 'workbench_event_bulk_delete', 'workbench_task_delete',
  'workbench_snapshot_replace', 'workbench_store_rollback',
]
check('T1.1 危险 op 未注册为 AI 工具',
  FORBIDDEN.every((n) => !names.includes(n)),
  '意外出现：' + (FORBIDDEN.filter((n) => names.includes(n)).join(',') || '无'))

const toolOps = defs.map((d) => d.op).filter((o) => typeof o === 'string')
check('T1.2 工具声明的 op 无一命中 DANGEROUS_OPS',
  toolOps.every((o) => !DANGEROUS_OPS.includes(o)),
  '命中：' + (toolOps.filter((o) => DANGEROUS_OPS.includes(o)).join(',') || '无'))

// ------------------------------------------------------------------ 2. AI 能否自行完成任务
const run = async (name, args, sessionId = AGENT) => {
  const def = defs.find((d) => d.name === name)
  assert.ok(def !== undefined, `工具不存在：${name}`)
  return def.execute.call({ service: host }, args, { agent: { session: { id: sessionId } } })
}

// **必须在同一会话内测**：真实 Host 按 sessionId 分目录，跨会话的写入会落到
// 另一个分片，用 USER 侧数据核对会得到「假 PASS」（那只是隔离生效，不是守卫生效）。
const S = USER
ex(S, 'task.upsert', { task: { id: 't-done', title: '用户的任务' } })
check('T2.0 初始 done=false',
  ex(S, 'task.list', {}).find((t) => t.id === 't-done').done !== true)

// 先照正常流程提交验收申请
await run('workbench_request_completion', { id: 't-done', summary: '我做完了' }, S)
check('T2.1 requestCompletion 后 done 仍为 false',
  ex(S, 'task.list', {}).find((t) => t.id === 't-done').done !== true)

const upsertRes = await run('workbench_task_upsert', {
  id: 't-done', title: '用户的任务', done: true,
}, S)
const afterUpsert = ex(S, 'task.list', {}).find((t) => t.id === 't-done')
console.log('  workbench_task_upsert(done:true) =>', JSON.stringify(upsertRes).slice(0, 200))
check('T2.2 AI 无法用 workbench_task_upsert 直接完成任务',
  afterUpsert.done !== true, `实际 done=${String(afterUpsert.done)}`)

const comp = afterUpsert.completion
check('T2.3 任务完成未经 completion 验收流程',
  comp === undefined || comp.status !== 'accepted',
  `completion=${JSON.stringify(comp ?? null)}`)

// ------------------------------------------------------------------ 3. AI 能否软删 / 存档
ex(S, 'task.upsert', { task: { id: 't-del', title: '待删除' } })
const delRes = await run('workbench_task_upsert', {
  id: 't-del', title: '待删除', deleted: true,
}, S)
const delRow = ex(S, 'task.list', { includeDeleted: true }).find((t) => t.id === 't-del')
console.log('  workbench_task_upsert(deleted:true) =>', JSON.stringify(delRes).slice(0, 200))
check('T3.1 AI 无法用 workbench_task_upsert 软删待办',
  delRow === undefined || delRow.deleted !== true, `deleted=${String(delRow?.deleted)}`)

// ------------------------------------------------------------------ 4. AI 能否落地提案
const plan = ex(AGENT, 'plan.suggest', {
  goal: '工具面绕过验证', targetTitles: ['子任务A'],
  windowStart: Date.parse('2026-11-09T00:00:00Z'),
  windowEnd: Date.parse('2026-11-16T00:00:00Z'),
})
const planId = plan.proposal.id
check('T4.1 AI 工具面没有“落地提案”的工具',
  defs.find((d) => /apply/i.test(d.name)) === undefined)

const taskBefore = ex(USER, 'task.list', {}).length
let confirmedIgnored = false
try { ex(AGENT, 'proposal.apply', { id: planId, confirmed: true }) }
catch (e) { confirmedIgnored = e.code === 'confirmation-required' }
check('T4.2 proposal.apply 不接受 payload.confirmed', confirmedIgnored)

let forgedRejected = false
try { ex(AGENT, 'proposal.apply', { id: planId }, { approvalToken: 'a'.repeat(64) }) }
catch (e) { forgedRejected = e.code === 'confirmation-required' }
check('T4.3 伪造 approvalToken 被拒', forgedRejected)

// 把 host 实例本身当成泄漏面（service 直接暴露 gate / store 写方法？）
const leaks = ['store', 'gate', 'approvalGate', 'events', 'service']
  .filter((k) => {
    const v = host[k]
    return v !== undefined && typeof v === 'object'
      && (typeof v.replace === 'function' || typeof v.mutate === 'function'
        || typeof v.rollback === 'function' || typeof v.issueForUserConfirm === 'function')
  })
check('T4.4 Host Service 没暴露可写的 store/gate/events', leaks.length === 0,
  leaks.join(',') || '无')

// 注意：真实 Host 按 sessionId 分目录，AGENT 生成的提案在 USER 侧不可见（P0-2）。
// 这里用 AGENT 自己的视角核对「提案未被落地」，并在 USER 侧核对业务数据未变。
const planStillPending = ex(AGENT, 'proposal.get', { id: planId }).proposal.status === 'pending'
check('T4.5 提案仍 pending、业务数据未变',
  planStillPending && ex(USER, 'task.list', {}).length === taskBefore,
  `pending=${planStillPending}`)

// ------------------------------------------------------------------ 5. help 文案
const help = await run('workbench_help', {})
check('T5.1 help 声明 AI 永远不能完成任务',
  /can NEVER complete/i.test(help.result.hint))

console.log('')
console.log(`探针1 汇总: PASS=${pass} FAIL=${fail}`)
rmSync(rootDir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

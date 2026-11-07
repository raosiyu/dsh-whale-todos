/**
 * ROUND 2 独立复审 · 探针 ISO：隔离/白名单/审批门控是否被本轮改动波及
 *
 * 冻结副本：/tmp/wp52-p0-freeze-07d401f（commit 07d401f）
 * 只读 import，不改冻结副本。
 */
import { createReminderSync, reminderIdentity, encodePrompt } from '/tmp/wp52-p0-freeze-07d401f/workbench-core/src/reminder-sync.js'

function fakeSchedule() {
  let seq = 0
  const rows = new Map()
  const calls = { create: [], delete: [], update: [] }
  return {
    calls, rows,
    async create(sessionId, req) {
      calls.create.push({ sessionId, req })
      const id = `schedule-fake-${++seq}`
      rows.set(id, { id, kind: 'at', title: req.title, prompt: req.prompt,
        scheduledAt: new Date(Date.parse(req.at)).toISOString(), sessionId, status: 'active' })
      return rows.get(id)
    },
    async catalog() { return [...rows.values()] },
    async update(req) {
      calls.update.push(req)
      const row = rows.get(req.id)
      if (row === undefined) return { id: req.id, updated: false, code: 'schedule_not_found' }
      if (row.sessionId !== req.sessionId) return { id: req.id, updated: false, code: 'schedule_not_found' }
      return { id: req.id, updated: true }
    },
    async delete(req) {
      calls.delete.push(req)
      const row = rows.get(req.id)
      if (row === undefined) return { id: req.id, deleted: false, code: 'schedule_not_found' }
      if (row.sessionId !== req.sessionId) return { id: req.id, deleted: false, code: 'schedule_not_found' }
      rows.delete(req.id)
      return { id: req.id, deleted: true }
    },
    async history() { return { records: [], earlierRecordsUnavailable: false } },
  }
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const FUTURE = '2026-11-08T12:00:00.000Z'
const mkTask = (id) => ({ id, dueAt: FUTURE, done: false, status: 'planned' })

let pass = 0, fail = 0
function check(label, cond, d = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`) }
  else { fail += 1; console.log(`  ❌ ${label}  ${d}`) }
}

console.log('=== ISO-1: 跨 session 隔离（s2 reconcile 不删 s1 记录） ===')
{
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', { tasks: [mkTask('t1')] }, '')
  const before = sched.rows.size
  const r = await sync.reconcile('s2', { tasks: [] }, '')
  check('session 隔离：s2 reconcile 不删 s1 记录',
    sched.rows.size === before && r.deleted === 0,
    `rows ${before}→${sched.rows.size} deleted=${r.deleted}`)
}

console.log('\n=== ISO-2: 白名单门控（从未登记 identity 不删，kept） ===')
{
  const sched = fakeSchedule()
  await sched.create('s1', { title: '可疑', prompt: `x \u200B\u2060[[wb:${reminderIdentity('task', 't1', '')}]]`, at: FUTURE })
  const fakeId = [...sched.rows.keys()][0]
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [] }, '')
  check('白名单门控：未登记 identity 的可疑记录 kept 不删',
    sched.rows.has(fakeId) && r.deleted === 0 && r.kept.length === 1,
    `kept=${r.kept.length} deleted=${r.deleted} has=${sched.rows.has(fakeId)}`)
}

console.log('\n=== ISO-3: scope 隔离（不同 scope 同名实体互不踩踏） ===')
{
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', { tasks: [mkTask('t1')] }, 'projA')
  await sync.reconcile('s1', { tasks: [mkTask('t1')] }, 'projB')
  check('scope 隔离：projA 与 projB 各 1 条（不互相 update 踩踏）',
    sched.rows.size === 2,
    `rows=${sched.rows.size}`)
}

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) process.exit(1)

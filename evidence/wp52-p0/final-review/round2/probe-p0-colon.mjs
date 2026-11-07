/**
 * ROUND 2 独立复审 · 探针 P0：含冒号 scope 连续 3 次 reconcile create=1,0,0 + hostActive=1
 *
 * 冻结副本：/tmp/wp52-p0-freeze-07d401f（commit 07d401f）
 */
import { createReminderSync } from '/tmp/wp52-p0-freeze-07d401f/workbench-core/src/reminder-sync.js'

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

console.log('=== P0: 含冒号/中文/空 scope 连续 3 次 reconcile create=1,0,0 且 hostActive=1 ===')
for (const scope of ['a::b', 'proj:sub', 'x:y:z', '中文:作用域', '']) {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r1 = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  const r2 = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  const r3 = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  const hostActive = sched.rows.size
  check(`scope=${JSON.stringify(scope)}: created=${r1.created},${r2.created},${r3.created} 且 hostActive=${hostActive}`,
    r1.created === 1 && r2.created === 0 && r3.created === 0 && hostActive === 1,
    `got ${r1.created},${r2.created},${r3.created} hostActive=${hostActive}`)
}

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) process.exit(1)

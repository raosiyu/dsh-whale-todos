/**
 * WP5.2-P0 独立复审 · 探针 D：核心修复（含冒号 scope 不重复 create）+ 隔离/白名单
 */
import assert from 'node:assert/strict'
import {
  createReminderSync,
  reminderIdentity,
} from '/tmp/wp52-p0-freeze-246e401.regenerated/workbench-core/src/reminder-sync.js'

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

console.log('=== Q4: 含冒号 scope 连续 3 次 reconcile 只 create 1 次 ===')
for (const scope of ['a::b', 'proj:sub', 'x:y:z', '中文:作用域', '']) {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r1 = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  const r2 = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  const r3 = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  check(`scope=${JSON.stringify(scope)}: created=1,0,0 且 Host 仅 1 条`,
    r1.created === 1 && r2.created === 0 && r3.created === 0 && sched.rows.size === 1,
    `got ${r1.created},${r2.created},${r3.created} rows=${sched.rows.size}`)
}

console.log('\n=== Q4b: 跨进程重启后不重复 create ===')
{
  const disk = new Map()
  const ownershipFor = (sid, sc) => ({ load: () => disk.get(`${sid}|${sc}`) ?? [], save: (ids) => disk.set(`${sid}|${sc}`, [...ids]) })
  const scope = 'a::b'
  const s1 = fakeSchedule()
  const sync1 = createReminderSync({ schedule: s1, now: () => NOW, ownershipFor })
  await sync1.reconcile('s1', { tasks: [mkTask('t1')] }, scope)

  const s2 = fakeSchedule()
  for (const row of s1.rows.values()) s2.rows.set(row.id, { ...row })
  const sync2 = createReminderSync({ schedule: s2, now: () => NOW, ownershipFor })
  const r2 = await sync2.reconcile('s1', { tasks: [mkTask('t1')] }, scope)
  check('重启后 created=0 且 Host 仍 1 条', r2.created === 0 && s2.rows.size === 1,
    `created=${r2.created} rows=${s2.rows.size}`)
}

console.log('\n=== Q6: 跨 session 隔离（Host 会话守卫必须拦住） ===')
{
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // session s1 建 t1
  await sync.reconcile('s1', { tasks: [mkTask('t1')] }, '')
  // session s2 也有 t1，但 catalog 里只有 s1 的记录（s2 不该删 s1 的）
  // ownHostRecords 按 sessionId 过滤，s2 看不到 s1 的记录 → 不该删
  const s2RowsBefore = sched.rows.size
  const r = await sync.reconcile('s2', { tasks: [] }, '')
  check('session 隔离：s2 reconcile 不删 s1 的记录',
    sched.rows.size === s2RowsBefore && r.deleted === 0,
    `s1 记录数 ${s2RowsBefore} → ${sched.rows.size}, deleted=${r.deleted}`)
}

console.log('\n=== Q6: 白名单门控（从未创建的 identity 不被删除） ===')
{
  const sched = fakeSchedule()
  // 塞一条 scope="" 的 v2 记录（identity=wb2.task..dDE），但我们「从未通过 ownership 登记」
  await sched.create('s1', {
    title: '可疑记录', prompt: '正文 \u200B\u2060[[wb:wb2.task..dDE]]', at: FUTURE,
  })
  const fakeId = [...sched.rows.keys()][0]
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // reconcile 空数据 → 期望集合为空 → 该记录应被列为 toDelete，
  // 但白名单里没有 → kept（不删）
  const r = await sync.reconcile('s1', { tasks: [] }, '')
  check('白名单门控：未登记 identity 的可疑记录不被删（kept）',
    sched.rows.has(fakeId) && r.deleted === 0 && r.kept.length === 1,
    `kept=${r.kept.length} deleted=${r.deleted} rows.has=${sched.rows.has(fakeId)}`)
}

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) process.exit(1)

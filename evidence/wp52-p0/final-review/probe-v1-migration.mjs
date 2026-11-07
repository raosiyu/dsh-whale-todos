/**
 * WP5.2-P0 独立复审 · 探针 B：v1→v2 迁移通道的跨 scope 误删风险
 *
 * 核心疑点：reconcile 的 legacy 迁移段里
 *   wantV2 = reminderIdentity(oldRow.decoded.kind, oldRow.decoded.entityId, scope)
 * 用的是「当前 reconcile 的 scope」，而不是 v1 记录自己解出来的 scope。
 * 对 legacyAmbiguous 记录而言，其真实 scope/entityId 边界本就不可靠，
 * 用当前 scope 重编码可能匹配到「另一个 scope 的 v2 记录」→ 误删。
 *
 * 只 import 冻结副本，不改任何文件。
 */
import assert from 'node:assert/strict'
import {
  createReminderSync,
  reminderIdentity,
  encodePrompt,
} from '/tmp/wp52-p0-freeze-246e401.regenerated/workbench-core/src/reminder-sync.js'

// 复刻测试里的假 schedule（行为对齐真实 Host 契约）
function fakeSchedule() {
  let seq = 0
  const rows = new Map()
  const calls = { create: [], delete: [] }
  return {
    calls, rows,
    async create(sessionId, req) {
      calls.create.push({ sessionId, req })
      const id = `schedule-fake-${++seq}`
      rows.set(id, {
        id, kind: 'at', title: req.title, prompt: req.prompt,
        scheduledAt: new Date(Date.parse(req.at)).toISOString(),
        sessionId, status: 'active',
      })
      return rows.get(id)
    },
    async catalog() { return [...rows.values()] },
    async update() { return { updated: true } },
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
const mkTask = (id, dueAt) => ({ id, dueAt, done: false, status: 'planned' })
const FUTURE = '2026-11-08T12:00:00.000Z'

let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`) }
  else { fail += 1; failures.push(label); console.log(`  ❌ ${label}  ${detail}`) }
}

console.log('=== 场景 1：v1 两段记录 task:t1（scope=""）在 reconcile(scope="projA") 下 ===')
{
  const sched = fakeSchedule()
  // 塞一条 v1 两段格式旧记录：task:t1 —— 历史语义 = 无 scope（即 scope=""）
  await sched.create('s1', {
    title: '旧提醒', prompt: '正文 \u200B\u2060[[wb:task:t1]]', at: FUTURE,
  })
  const oldId = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // 当前数据里 entity t1 只存在于 scope="projA"
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', FUTURE)] }, 'projA')

  const oldStillThere = sched.rows.has(oldId)
  const deletedCalls = sched.calls.delete.filter((d) => d.id === oldId)
  console.log(`    created=${r.created} legacyMigrated=${r.legacyMigrated} legacyKept=${r.legacyKept.length}`)
  console.log(`    旧记录 task:t1 (scope="") 是否被删：${deletedCalls.length > 0 ? '是 ❌' : '否 ✅'}`)
  check('v1 两段记录 task:t1（scope=""）在 reconcile(scope="projA") 下【不被误删】',
    oldStillThere, `legacyMigrated=${r.legacyMigrated}, 旧记录被删=${deletedCalls.length > 0}`)
}

console.log('\n=== 场景 2：v1 _ 占位记录 task:_:t1 在 reconcile(scope="_") vs scope="" ===')
{
  // v1 里 scope="" 与 scope="_" 都写成 task:_:t1 —— 二者无法区分
  const sched = fakeSchedule()
  await sched.create('s1', {
    title: '旧提醒', prompt: '正文 \u200B\u2060[[wb:task:_:t1]]', at: FUTURE,
  })
  const oldId = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // 当前只在 scope="_" 有 entity t1；scope="" 无 entity t1
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', FUTURE)] }, '_')

  const oldStillThere = sched.rows.has(oldId)
  const deletedCalls = sched.calls.delete.filter((d) => d.id === oldId)
  console.log(`    created=${r.created} legacyMigrated=${r.legacyMigrated} legacyKept=${r.legacyKept.length}`)
  console.log(`    task:_:t1 是否被删：${deletedCalls.length > 0 ? '是' : '否'}`)
  // 注意：这个场景下 _ 与 "" 在 v1 本就撞车，删或不删都有争议；
  // 关键判据：不得在「无法确认它属于哪个 scope」时删。
  // 这里 reconcile(scope="_") 下，decode 得到 scope=""（占位），而当前 scope="_"，
  // 若迁移通道用当前 scope 重编码，可能误判。记录实际行为。
  console.log(`    [观察] 旧记录删除行为：${deletedCalls.length > 0 ? '被删除' : '保留'}`)
}

console.log('\n=== 场景 3：v1 三段但 id 含冒号 task:projA:a:b（边界已丢）===')
{
  const sched = fakeSchedule()
  await sched.create('s1', {
    title: '旧提醒', prompt: '正文 \u200B\u2060[[wb:task:projA:a:b]]', at: FUTURE,
  })
  const oldId = [...sched.rows.keys()][0]
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [mkTask('a:b', FUTURE)] }, 'projA')
  const oldStillThere = sched.rows.has(oldId)
  const deletedCalls = sched.calls.delete.filter((d) => d.id === oldId)
  console.log(`    created=${r.created} legacyMigrated=${r.legacyMigrated} legacyKept=${r.legacyKept.length} reason=${r.legacyKept[0]?.reason}`)
  console.log(`    task:projA:a:b 是否被删：${deletedCalls.length > 0 ? '是' : '否'}`)
  check('v1 边界已丢记录 task:projA:a:b 不被删（保守保留）', oldStillThere,
    `legacyMigrated=${r.legacyMigrated}, 被删=${deletedCalls.length > 0}`)
}

console.log('\n=== 场景 4：v1 三段无歧义 task:projA:t1 应被安全迁移 ===')
{
  const sched = fakeSchedule()
  await sched.create('s1', {
    title: '旧提醒', prompt: '正文 \u200B\u2060[[wb:task:projA:t1]]', at: FUTURE,
  })
  const oldId = [...sched.rows.keys()][0]
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', FUTURE)] }, 'projA')
  console.log(`    created=${r.created} legacyMigrated=${r.legacyMigrated} legacyKept=${r.legacyKept.length}`)
  // task:projA:t1 是「无歧义」的 v1（scope 真实非空、id 不含冒号），
  // decodeIdentity 不标 legacyAmbiguous → 不进 legacyHostRecords → 不会迁移。
  // 观察：它是被当 owned 删除（via ownHostRecords diff）还是保留。
  console.log(`    [观察] 无歧义 v1 是否走迁移/删除：legacyMigrated=${r.legacyMigrated}`)
}

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}

/**
 * ROUND 2 独立复审 · 探针 B1：跨 scope 的 v1 旧记录绝不被删 + 迁移通道彻底移除
 *
 * 冻结副本：/tmp/wp52-p0-freeze-07d401f（commit 07d401f）
 * 只读 import，不改冻结副本。
 */
import {
  createReminderSync,
  reminderIdentity,
  encodePrompt,
  decodeIdentity,
  ownershipOf,
} from '/tmp/wp52-p0-freeze-07d401f/workbench-core/src/reminder-sync.js'

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

// v1 旧记录 prompt 里带不可见前缀标记（本插件早先写下的形态）
const v1Mark = (identity) => `正文 \u200B\u2060[[wb:${identity}]]`

console.log('=== B1-a: 跨 scope 的 v1 旧记录绝不被删、零 delete 调用 ===')
// 场景矩阵：{ 旧记录 identity, 旧记录语义 scope, reconcile 时用的 scope, 数据里是否有同 id 实体 }
const scenarios = [
  // [旧 identity, 语义 scope, reconcile scope, 数据 id] —— B1 的原始误删形态
  { oldId: 'task:t1',        sem: '',      rec: 'projA',     dataId: 't1'  }, // 两段，空 scope 旧记录，在 projA 下 reconcile
  { oldId: 'task:_:t1',      sem: '',      rec: 'projA',     dataId: 't1'  }, // 三段 `_` 占位
  { oldId: 'task:projA:a:b', sem: 'projA', rec: 'projA',     dataId: 'a:b' }, // 三段 id 含冒号
  { oldId: 'task:a::b:t1',   sem: 'a::b',  rec: 'a::b',      dataId: 't1'  }, // 三段 scope 含冒号
  { oldId: 'task:t1',        sem: '',      rec: '',          dataId: 't1'  }, // 两段，空 scope，同 scope reconcile（也应不删）
  { oldId: 'event-start:t1', sem: '',      rec: 'projA',     dataId: 't1'  }, // event kind 两段
]
for (const sc of scenarios) {
  const sched = fakeSchedule()
  await sched.create('s1', { title: '旧', prompt: v1Mark(sc.oldId), at: FUTURE })
  const oldRowId = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // reconcile 的数据：若 dataId 非空则放一个同名 task/event，制造「同名 v2 会撞」的极端条件
  const data = sc.oldId.startsWith('event-start')
    ? { events: [{ id: sc.dataId, start: FUTURE, allDay: false }] }
    : { tasks: [{ id: sc.dataId, dueAt: FUTURE, done: false }] }
  const r = await sync.reconcile('s1', data, sc.rec)

  const stillThere = sched.rows.has(oldRowId)
  const deleteCallsForOld = sched.calls.delete.filter((d) => d.id === oldRowId).length
  const totalDelete = sched.calls.delete.length

  check(`旧记录 ${JSON.stringify(sc.oldId)} (sem=${JSON.stringify(sc.sem)}) 在 scope=${JSON.stringify(sc.rec)} 下仍保留`,
    stillThere, `rows.has=${stillThere}`)
  check(`  对该旧记录 delete 调用 = 0`,
    deleteCallsForOld === 0, `deleteCallsForOld=${deleteCallsForOld}`)
  check(`  全轮 delete 调用 = 0（任何旧记录都不得删）`,
    totalDelete === 0, `totalDelete=${totalDelete}`)
}

console.log('\n=== B1-b: 迁移通道彻底移除（report 无 legacyMigrated/legacyKept 字段） ===')
{
  const sched = fakeSchedule()
  await sched.create('s1', { title: '旧', prompt: v1Mark('task:t1'), at: FUTURE })
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1')] }, 'projA')
  const hasLegacyMigrated = 'legacyMigrated' in r
  const hasLegacyKept = 'legacyKept' in r
  check('reconcile report 不含 legacyMigrated 字段（迁移通道已移除）', !hasLegacyMigrated)
  check('reconcile report 不含 legacyKept 字段（迁移通道已移除）', !hasLegacyKept)
  console.log('  report keys =', Object.keys(r).join(','))
}

console.log('\n=== B1-c: 迁移通道 3 个标记在 src + test 全树 0 命中 ===')
// 由 shell 侧 grep 复核，这里只做逻辑断言占位说明（实际 grep 见 probe-b1-cross-scope.log 前的 shell）

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) process.exit(1)

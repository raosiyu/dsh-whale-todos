/**
 * WP5.2-P0 独立复审 · 探针 C：迁移通道误删的最小复现 + 白名单绕过
 *
 * 复现：v1 两段旧记录 task:t1 语义 = 空 scope（scope=""）。
 * 当 reconcile 以 scope="projA" 运行时（且 projA 下也有 entity t1），
 * 迁移通道用「当前 scope」重编码 → 匹配到 projA 的 v2 新记录 → 删掉
 * 那条其实属于空 scope 的旧记录。
 *
 * 同时证明：迁移删除路径不做白名单（createdIdentities）校验。
 */
import {
  createReminderSync,
  reminderIdentity,
} from '/tmp/wp52-p0-freeze-246e401.regenerated/workbench-core/src/reminder-sync.js'

function fakeSchedule() {
  let seq = 0
  const rows = new Map()
  const calls = { create: [], delete: [] }
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
const FUTURE = '2026-11-08T12:00:00.000Z'

const sched = fakeSchedule()

// 1) 塞一条 v1 两段旧记录：task:t1 —— 历史语义 = 空 scope（scope=""）
await sched.create('s1', {
  title: '旧提醒(空scope)', prompt: '正文 \u200B\u2060[[wb:task:t1]]', at: FUTURE,
})
const oldId = [...sched.rows.keys()][0]

// 2) 以 scope="projA" 运行 reconcile，projA 下也有 entity t1
const sync = createReminderSync({ schedule: sched, now: () => NOW })
const r = await sync.reconcile('s1', { tasks: [{ id: 't1', dueAt: FUTURE, done: false, status: 'planned' }] }, 'projA')

const oldDeleted = !sched.rows.has(oldId)
console.log('created        =', r.created)
console.log('legacyMigrated =', r.legacyMigrated, '（>0 表示旧记录被迁移删除）')
console.log('legacyKept     =', r.legacyKept.length)
console.log('旧记录(task:t1, 空scope) 是否被删 =', oldDeleted)
console.log('删除调用明细 =', JSON.stringify(sched.calls.delete))

// 3) 白名单绕过：本轮 create 的 identity 是 projA 的 v2，不是空 scope 的 v1；
//    迁移删除路径不查 createdIdentities。
const projAIdentity = reminderIdentity('task', 't1', 'projA')
const emptyScopeIdentity = reminderIdentity('task', 't1', '')
console.log('本轮真正创建的是 =', projAIdentity)
console.log('被删旧记录本应属于 =', emptyScopeIdentity, '(空 scope)')
console.log('结论：跨 scope 误删 =', oldDeleted && projAIdentity !== emptyScopeIdentity ? '是 ❌' : '否')
console.log('      白名单(空 scope 的 identity)从未登记 =', emptyScopeIdentity, '却仍被删 =', oldDeleted)

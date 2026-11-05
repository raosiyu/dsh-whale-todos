/** 坐实：键重复导致 remove 只删得掉一条，另一条成孤儿 */
import { createScheduleAdapter } from '../workbench-core/src/index.js'
const T = Date.UTC(2026, 10, 1, 9, 0, 0)
const store = [
  { id: 'h-A', title: '站会', scheduledAt: new Date(T).toISOString() },
  { id: 'h-B', title: '站会', scheduledAt: new Date(T).toISOString() },
]
const removed = []
let created = 0
const host = {
  create: async () => { created += 1; return { id: `new-${created}` } },
  remove: async (id) => { removed.push(id); const i = store.findIndex(r => r.id === id); if (i >= 0) store.splice(i, 1) },
  list: async () => store.map(r => ({ id: r.id, title: r.title, scheduledAt: r.scheduledAt })),
  history: async () => [],
}
const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: host, now: () => T })
const listed = await adapter.list()
console.log('宿主 2 条 → list():', listed.map(x => `${x.reminderKey.slice(0,14)}…(${x.hostId})`))
console.log('两键相同?', listed[0].reminderKey === listed[1].reminderKey)

// 用这个键去 cancel：只能删掉一条
await adapter.cancel(listed[0].reminderKey)
console.log(`\ncancel 一条后：宿主剩余 ${store.length} 条  [${store.map(r=>r.id).join(', ')}]`)
console.log(`  ${store.length === 1 ? '❌ 键冲突导致只删掉 1 条，另一条成为孤儿（用户看到"取消了一条，另一条还在响"）' : '✅'} `)

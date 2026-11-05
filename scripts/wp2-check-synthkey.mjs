/** 攻击 title+at 合成键：是否会误合并两条合法但不同的提醒（丢提醒） */
import { createScheduleAdapter } from '../workbench-core/src/index.js'

const T = Date.UTC(2026, 10, 1, 9, 0, 0)

// 宿主**不回报 key**（真实 ctx.schedule 可能只给 id/title/scheduledAt）
function makeHost(rows) {
  return {
    create: async (i) => ({ id: `h-${rows.length + 1}` }),
    remove: async () => {},
    list: async () => rows.map((r) => ({ id: r.id, title: r.title, scheduledAt: r.scheduledAt })),
    history: async () => [],
  }
}

console.log('=== 场景 A：两个不同事件，标题相同、触发时刻相同（现实常见：两个 9:00 的日程都叫「站会」）===')
{
  const rows = [
    { id: 'h-A', title: '站会', scheduledAt: new Date(T).toISOString() },
    { id: 'h-B', title: '站会', scheduledAt: new Date(T).toISOString() },
  ]
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: makeHost(rows), now: () => T })
  const listed = await adapter.list()
  console.log(`  宿主实际条数=${rows.length}  适配器 list() 条数=${listed.length}`)
  console.log(`  键:`, listed.map((x) => x.reminderKey))
  console.log(`  ${listed.length < rows.length ? '❌ 误合并——丢了一条提醒（宿主的 h-B 被 h-A 覆盖）' : '✅ 未合并'}`)
}

console.log('')
console.log('=== 场景 B：同一时刻但 ISO 格式不同（Z vs .000Z）===')
{
  const rows = [
    { id: 'h-C', title: '站会', scheduledAt: '2026-11-01T09:00:00Z' },
    { id: 'h-D', title: '站会', scheduledAt: '2026-11-01T09:00:00.000Z' },
  ]
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: makeHost(rows), now: () => T })
  const listed = await adapter.list()
  console.log(`  宿主条数=${rows.length}  list() 条数=${listed.length}`)
  console.log(`  键:`, listed.map((x) => x.reminderKey))
  console.log(`  ${listed.length === rows.length ? '⚠️ 未合并（格式差异导致同一提醒被当成两条 → 反向问题：去重失效）' : '✅ 合并了'}`)
}

console.log('')
console.log('=== 场景 C：同标题同刻，但 reconcile 时 desired 里是两条不同 reminderKey ===')
{
  const rows = [
    { id: 'h-E', title: '站会', scheduledAt: new Date(T).toISOString() },
    { id: 'h-F', title: '站会', scheduledAt: new Date(T).toISOString() },
  ]
  let created = 0, removed = 0
  const host = {
    create: async () => { created += 1; return { id: `new-${created}` } },
    remove: async () => { removed += 1 },
    list: async () => rows.map((r) => ({ id: r.id, title: r.title, scheduledAt: r.scheduledAt })),
    history: async () => [],
  }
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: host, now: () => T })
  const plans = [
    { reminderKey: 'event:ev1:o1:15', fireAtMs: T, title: '站会', prompt: 'p1' },
    { reminderKey: 'event:ev2:o1:15', fireAtMs: T, title: '站会', prompt: 'p2' },
  ]
  const r = await adapter.reconcile(plans)
  console.log(`  created=${r.created.length} removed=${r.removed.length} 宿主新增=${created} 宿主删除=${removed}`)
  console.log(`  ${r.removed.length > 0 ? '❌ 把宿主里合法存在的提醒当成"多余"删掉了（合成键不在 desired 里）' : '✅ 未误删'}`)
}

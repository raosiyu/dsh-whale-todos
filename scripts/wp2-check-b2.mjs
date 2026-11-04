/** B2：已投递（已出队）的提醒在宽限期内被重新注册 */
import { createScheduleAdapter, createReminderRecovery } from '../workbench-core/src/index.js'
const T = Date.UTC(2026, 10, 1, 12, 0, 0), MIN = 60000
const hostStore = []; let seq = 0
const hostSchedule = {
  create: async (i) => { const id = `h-${++seq}`; hostStore.push({ id, key: i.key, at: i.at }); return { id } },
  remove: async (id) => { const k = hostStore.findIndex(r => r.id === id); if (k >= 0) hostStore.splice(k, 1) },
  list: async () => hostStore.map(r => ({ id: r.id, key: r.key, scheduledAt: new Date(r.at).toISOString() })),
  history: async () => [],
}
const plan = [{ reminderKey: 'k1', fireAtMs: T, title: 'x', prompt: 'x' }]
const mkAdapter = (nowMs) => createScheduleAdapter({ backend: 'host', now: () => nowMs, hostSchedule })

// 进程1：建立并到点投递（模拟宿主投递后出队）
{
  const a = mkAdapter(T - MIN)
  await a.reconcile(plan)
  console.log('建立后 宿主=', hostStore.length)
  hostStore.length = 0            // 模拟「到点投递并出队」
  console.log('投递出队后 宿主=', hostStore.length)
}
// 12:00:30 重启，宽限期 60s 内
{
  const wake = T + 30 * 1000
  const a = mkAdapter(wake)
  const rec = createReminderRecovery({ adapter: a, now: () => wake, graceMs: MIN })
  const r = await rec.recover(plan, { scenario: 'restart', atMs: wake })
  console.log(`12:00:30 重启: restored=${r.restored.length} missed=${r.missed.length} 宿主=${hostStore.length}`)
  console.log('重新注册的 at =', hostStore.map(x => new Date(x.at).toISOString()))
  console.log(`\n结论：${hostStore.length > 0 && hostStore[0].at <= wake ? '❌ B2 成立——已投递的提醒被重新注册（过去时刻）' : '✅ 未重投'}`)
}

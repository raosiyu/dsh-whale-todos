/** 复现 B1：host 后端重启后是否重复注册 */
import { createScheduleAdapter, createReminderRecovery, rebuildPlans,
         validateEventInput, normalizeEventInput } from '../workbench-core/src/index.js'

const BASE = Date.UTC(2026, 10, 1, 0, 0, 0)
const MIN = 60000
const wall = (ms) => new Date(ms).toISOString().slice(0, 16)
const mk = (startMs, id) => {
  const s = wall(startMs), e = wall(startMs + 30 * MIN)
  return { id, uid: id, ...normalizeEventInput(validateEventInput({ title: id, allDay: false, start: s, end: e, timeZone: 'UTC' })), createdAt: 'x', updatedAt: 'x', deletedAt: null, status: 'confirmed' }
}

// 模拟「宿主侧真实存储」：一个数组，模拟进程重启后仍然存在（宿主是持久的）
const hostStore = []
let hostSeq = 0
const hostSchedule = {
  create: async (input) => { const id = `host-${++hostSeq}`; hostStore.push({ id, key: input.key, at: input.at, title: input.title }); return { id } },
  remove: async (id) => { const i = hostStore.findIndex(r => r.id === id); if (i >= 0) hostStore.splice(i, 1) },
  list: async () => hostStore.map(r => ({ id: r.id, key: r.key, scheduledAt: new Date(r.at).toISOString() })),
  history: async () => [],
}

const events = [mk(BASE + 2 * 3600 * 1000, 'e1')]

for (let round = 1; round <= 3; round += 1) {
  // 每次「重启」都新建 adapter（模拟进程重启，内存映射丢失）
  const adapter = createScheduleAdapter({ backend: 'host', now: () => BASE, defaultLeadMinutes: 15, hostSchedule })
  const plans = rebuildPlans({ adapter, events, now: () => BASE, leadMinutes: 15 })
  const rec = createReminderRecovery({ adapter, now: () => BASE, graceMs: MIN })
  const r = await rec.recover(plans, { scenario: 'restart', atMs: BASE })
  console.log(`第 ${round} 次重启: restored=${r.restored.length}  宿主侧提醒总数=${hostStore.length}`)
}
console.log('宿主侧 at 值:', hostStore.map(r => new Date(r.at).toISOString()))
console.log(`\n结论：${hostStore.length > 1 ? '❌ B1 成立——每次重启多注册一条' : '✅ 不重复'}`)

/**
 * WP2 三场景验证（修订版）：每个场景独立 adapter，避免状态串味。
 */
import {
  createScheduleAdapter, createReminderRecovery, rebuildPlans,
  createWorkbenchService, validateEventInput, normalizeEventInput,
} from '../workbench-core/src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIN = 60_000, HOUR = 3_600_000
const log = (...a) => console.log(...a)

// 固定基准，算术可复现
const BASE = Date.UTC(2026, 10, 4, 18, 0, 0)
const wall = (ms) => new Date(ms).toISOString().slice(0, 16)
const mk = (startMs, title, id) => {
  const s = wall(startMs), e = wall(startMs + 30 * MIN)
  const input = validateEventInput({ title, allDay: false, start: s, end: e, timeZone: 'UTC' })
  return { id: id ?? title, uid: id ?? title, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null, status: 'confirmed' }
}
const EVENTS = [mk(BASE + 2 * HOUR, '两小时后', 'e1'), mk(BASE + 4 * HOUR, '四小时后', 'e2')]

const freshAdapter = () => createScheduleAdapter({ backend: 'memory', now: () => BASE, defaultLeadMinutes: 15 })
const plansFrom = (adapter, atMs) =>
  rebuildPlans({ adapter, events: EVENTS, now: () => atMs, leadMinutes: 15, lookbackDays: 1 })

function report(name, r, scheduled, expected) {
  log(`  结果：restored=${r.restored.length} missed=${r.missed.length} removed=${r.removed.length}`)
  log(`  计划中提醒=${scheduled}（期望 ${expected}）`)
  log(`  ${scheduled === expected ? '✅ 符合预期' : '❌ 不符合预期'}`)
}

// ---- 场景 1：restart ----
log('=== 场景 1：restart（进程重启 → 从持久化重建，未来提醒必须恢复）===')
{
  const adapter = freshAdapter()
  const plans = plansFrom(adapter, BASE)
  log(`  重建出 ${plans.length} 条计划（e1 +1h45m、e2 +3h45m）`)
  const rec = createReminderRecovery({ adapter, now: () => BASE, graceMs: MIN })
  const r = await rec.recover(plans, { scenario: 'restart', atMs: BASE })
  report('restart', r, (await adapter.list()).length, 2)
  const again = await rec.recover(plans, { scenario: 'restart', atMs: BASE })
  log(`  幂等复跑新增=${again.restored.length}（期望 0）${again.restored.length === 0 ? ' ✅' : ' ❌'}`)
}

// ---- 场景 2：suspend ----
log('')
log('=== 场景 2：suspend（休眠 3 小时 → 唤醒时 e1 的提醒已过期）===')
{
  const adapter = freshAdapter()
  await adapter.reconcile(plansFrom(adapter, BASE))   // 睡前状态
  const wake = BASE + 3 * HOUR
  const plansAtWake = plansFrom(adapter, wake)
  const rec = createReminderRecovery({ adapter, now: () => wake, graceMs: MIN })
  const r = await rec.recover(plansAtWake, { scenario: 'suspend', atMs: wake })
  // 唤醒时 e1 提醒(+1h45m) 已过 → missed；e2(+3h45m) 未到 → 恢复
  report('suspend', r, (await adapter.list()).length, 1)
  log(`  过期未补发=${r.missed.length} 条（期望 1）；不轰炸用户 ${r.missed.length === 1 ? '✅' : '❌'}`)
  log(`  摘要：${rec.summarizeMissed(plansAtWake.filter(p => r.missed.includes(p.reminderKey)))}`)
}

// ---- 场景 3：exit ----
log('')
log('=== 场景 3：exit（提醒到点前退出 → 1 小时后重开，两条提醒都还在未来）===')
{
  const adapter = freshAdapter()
  await adapter.reconcile(plansFrom(adapter, BASE))   // 退出前状态
  const reopen = BASE + 1 * HOUR
  const plansAtReopen = plansFrom(adapter, reopen)
  const rec = createReminderRecovery({ adapter, now: () => reopen, graceMs: MIN })
  const r = await rec.recover(plansAtReopen, { scenario: 'exit', atMs: reopen })
  report('exit', r, (await adapter.list()).length, 2)
  log(`  无提醒被误判错过 ${r.missed.length === 0 ? '✅' : '❌'}`)
}

// ---- 到点投递 ----
log('')
log('=== 到点投递与幂等（独立 adapter）===')
{
  const adapter = freshAdapter()
  const plans = plansFrom(adapter, BASE)
  await adapter.reconcile(plans)
  const fireAt = Math.min(...(await adapter.list()).map(p => p.fireAtMs))
  const t1 = adapter._tick(fireAt)
  const t2 = adapter._tick(fireAt + MIN)
  const hist = await adapter.history()
  log(`  首次 tick=${t1.length}（期望 1）${t1.length === 1 ? ' ✅' : ' ❌'}`)
  log(`  重复 tick=${t2.length}（期望 0）${t2.length === 0 ? ' ✅' : ' ❌'}`)
  log(`  history=${hist.length}，与真实投递一致=${hist.length === t1.length ? '✅' : '❌'}`)
}

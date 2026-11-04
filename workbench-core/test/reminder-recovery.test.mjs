import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createScheduleAdapter,
  createReminderRecovery,
  rebuildPlans,
  RECOVERY_SCENARIOS,
  validateEventInput,
  normalizeEventInput,
} from '../src/index.js'

const MIN = 60 * 1000
const DAY = 86400000

let seq = 0
const ev = (start, over = {}, id) => {
  // 结束时间默认 +1 分钟（不能等于 start，模型层要求 end > start）
  const [d, t] = start.split('T')
  const [hh, mm] = t.split(':').map(Number)
  const endMinutes = hh * 60 + mm + 1
  const end = `${d}T${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
  const input = validateEventInput({
    title: `事件${++seq}`, allDay: false, start, end,
    timeZone: 'UTC', ...over,
  })
  const finalId = id ?? `r-${seq}`
  return { id: finalId, uid: `ru-${finalId}`, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null, status: 'confirmed' }
}

function mkAdapter(base, leadMinutes = 15) {
  return createScheduleAdapter({ backend: 'memory', now: () => base, defaultLeadMinutes: leadMinutes })
}

test('恢复：三个场景常量齐备', () => {
  assert.deepEqual([...RECOVERY_SCENARIOS].sort(), ['exit', 'restart', 'suspend'])
})

test('恢复：未知场景被拒绝', async () => {
  const base = Date.UTC(2026, 10, 1)
  const adapter = mkAdapter(base)
  const rec = createReminderRecovery({ adapter, now: () => base })
  await assert.rejects(() => rec.recover([], { scenario: 'tsunami' }), /未知恢复场景/)
})

test('场景 restart：未来的提醒被恢复，过去的记 missed 不补发', async () => {
  const base = Date.UTC(2026, 10, 1, 0, 0, 0)
  const adapter = mkAdapter(base)
  // 事件 A：2 小时后（未来，应恢复）；事件 B：3 小时前（过去，应 missed）
  const events = [ev('2026-11-01T02:15'), ev('2026-10-31T21:15')]
  const plans = rebuildPlans({ adapter, events, now: () => base, leadMinutes: 15 })
  assert.equal(plans.length, 2)

  const rec = createReminderRecovery({ adapter, now: () => base, graceMs: MIN })
  const res = await rec.recover(plans, { scenario: 'restart', atMs: base })

  assert.equal(res.restored.length, 1, '未来提醒应被恢复')
  assert.equal(res.missed.length, 1, '过去提醒应记为错过')
  assert.equal(res.skippedPast, 1)
  assert.equal((await adapter.list()).length, 1)
})

test('场景 suspend：宽限期内仍补建，超过宽限期记 missed', async () => {
  const base = Date.UTC(2026, 10, 1, 0, 0, 0)
  const adapter = mkAdapter(base)
  // 两个都「已到点」，但一个在宽限期内、一个超出
  const plans = [
    { reminderKey: 'k-soon', fireAtMs: base - 30 * 1000, title: '刚过期', prompt: 'p1' },
    { reminderKey: 'k-old', fireAtMs: base - 10 * MIN, title: '久过期', prompt: 'p2' },
  ]
  const rec = createReminderRecovery({ adapter, now: () => base, graceMs: MIN })
  const res = await rec.recover(plans, { scenario: 'suspend', atMs: base })

  assert.equal(res.restored.length, 1, '宽限期内应补建')
  assert.equal(res.missed.length, 1, '超宽限应记错过')
})

test('场景 exit：退出期间到点的提醒不补发（避免轰炸）', async () => {
  const base = Date.UTC(2026, 10, 1, 0, 0, 0)
  const adapter = mkAdapter(base)
  // 模拟用户关掉应用 6 小时后又打开
  const events = [ev('2026-11-01T01:00'), ev('2026-11-01T02:00'), ev('2026-11-01T03:00'), ev('2026-11-01T20:00')]
  const plans = rebuildPlans({ adapter, events, now: () => base, leadMinutes: 0 })
  const wakeAt = base + 6 * 3600 * 1000

  const rec = createReminderRecovery({ adapter, now: () => wakeAt, graceMs: MIN })
  const res = await rec.recover(plans, { scenario: 'exit', atMs: wakeAt })

  assert.equal(res.missed.length, 3, '已过去的 3 条应记 missed')
  assert.equal(res.restored.length, 1, '只有 20:00 那条还在未来')
})

test('恢复幂等：同一状态重复恢复不产生重复提醒', async () => {
  const base = Date.UTC(2026, 10, 1, 0, 0, 0)
  const adapter = mkAdapter(base)
  const events = [ev('2026-11-01T02:15'), ev('2026-11-01T03:15')]
  const plans = rebuildPlans({ adapter, events, now: () => base, leadMinutes: 15 })
  const rec = createReminderRecovery({ adapter, now: () => base, graceMs: MIN })

  const first = await rec.recover(plans, { scenario: 'restart', atMs: base })
  assert.equal(first.restored.length, 2)
  const second = await rec.recover(plans, { scenario: 'restart', atMs: base })
  assert.equal(second.restored.length, 0, '重复恢复不得重复建立')
  assert.equal((await adapter.list()).length, 2)
})

test('恢复会清掉不再需要的旧提醒（事件被删后）', async () => {
  const base = Date.UTC(2026, 10, 1, 0, 0, 0)
  const adapter = mkAdapter(base)
  // 复用同一事件 id，才能验证「事件被删 → 其提醒被取消」
  const keepEvent = ev('2026-11-01T02:15', {}, 'keep-me')
  const dropEvent = ev('2026-11-01T03:15', {}, 'drop-me')
  const before = rebuildPlans({ adapter, events: [keepEvent, dropEvent], now: () => base, leadMinutes: 15 })
  await adapter.reconcile(before)
  assert.equal((await adapter.list()).length, 2)

  const after = rebuildPlans({ adapter, events: [keepEvent], now: () => base, leadMinutes: 15 })
  const rec = createReminderRecovery({ adapter, now: () => base, graceMs: MIN })
  const res = await rec.recover(after, { scenario: 'restart', atMs: base })
  assert.equal(res.removed.length, 1, '被删事件的提醒必须取消')
  assert.equal((await adapter.list()).length, 1)
})

test('错过摘要：空与多条都给出可读文案', () => {
  const base = Date.now()
  const adapter = mkAdapter(base)
  const rec = createReminderRecovery({ adapter, now: () => base })
  assert.equal(rec.summarizeMissed([]), '没有错过的提醒')
  const msg = rec.summarizeMissed([
    { title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' },
  ])
  assert.match(msg, /错过 4 条提醒/)
  assert.match(msg, /A、B、C/)
  assert.match(msg, /等 4 条/)
})

test('rebuildPlans 合并事件与任务提醒，且不把已完成的算进来', () => {
  const base = Date.UTC(2026, 10, 1, 0, 0, 0)
  const adapter = mkAdapter(base)
  const plans = rebuildPlans({
    adapter,
    events: [ev('2026-11-01T02:15')],
    tasks: [
      { id: 't1', title: '交报告', dueAt: '2026-11-01T05:00:00.000Z' },
      { id: 't2', title: '已完成', dueAt: '2026-11-01T05:00:00.000Z', done: true },
    ],
    now: () => base,
    leadMinutes: 15,
  })
  assert.equal(plans.length, 2, '1 事件 + 1 任务（跳过已完成）')
})

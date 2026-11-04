import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_MODES,
  approvalFingerprint,
  createHostApprovalGate,
  createScheduleAdapter,
  createMemoryBackend,
  DEFAULT_LEAD_MINUTES,
  reminderKeyOf,
  compileReminder,
  REMINDER_KINDS,
  validateEventInput,
  normalizeEventInput,
  WorkbenchError,
  ERROR_CODES,
} from '../src/index.js'

const MIN = 60 * 1000

// ---------------------------------------------------------------- 审批门

test('审批门：isolated 必须显式允许，否则构造即失败', () => {
  assert.throws(
    () => createHostApprovalGate({ mode: 'isolated' }),
    (e) => e instanceof WorkbenchError && /allowIsolated/.test(e.message),
  )
  const gate = createHostApprovalGate({ mode: 'isolated', allowIsolated: true })
  assert.equal(gate.mode, 'isolated')
})

test('审批门：未知模式被拒绝', () => {
  assert.throws(() => createHostApprovalGate({ mode: 'yolo' }), /未知审批模式/)
  assert.ok(APPROVAL_MODES.includes('host'))
})

test('审批门：host 模式默认不自动批准（缺 requester 时拒绝）', async () => {
  const gate = createHostApprovalGate({ mode: 'host' })
  const res = await gate.request({ op: 'event.delete', summary: 'x' })
  assert.equal(res.approved, false)
  assert.equal(res.reason, 'host-requester-missing')
})

test('审批门：host 模式按宿主决定放行或拒绝', async () => {
  let answer = 'approved'
  const gate = createHostApprovalGate({
    mode: 'host',
    request: async () => answer,
  })
  const ok = await gate.request({ op: 'event.delete', summary: 'x' })
  assert.equal(ok.approved, true)
  assert.ok(ok.token)
  answer = 'denied'
  const no = await gate.request({ op: 'event.delete', summary: 'y' })
  assert.equal(no.approved, false)
})

test('审批门：凭证一次性，重放被拒', async () => {
  const gate = createHostApprovalGate({ mode: 'isolated', allowIsolated: true })
  const { token } = await gate.request({ op: 'event.delete', target: 'e1', summary: 'x' })
  assert.equal(gate.verify({ op: 'event.delete', target: 'e1' }, token).ok, true)
  const replay = gate.verify({ op: 'event.delete', target: 'e1' }, token)
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'unknown-token')
})

test('审批门：凭证绑定操作指纹，不能挪用到别的操作', async () => {
  const gate = createHostApprovalGate({ mode: 'isolated', allowIsolated: true })
  const { token } = await gate.request({ op: 'event.delete', target: 'e1', summary: 'x' })
  const wrong = gate.verify({ op: 'event.delete', target: 'e2' }, token)
  assert.equal(wrong.ok, false)
  assert.equal(wrong.reason, 'fingerprint-mismatch')
})

test('审批门：凭证过期后失效', async () => {
  let t = 1000
  const gate = createHostApprovalGate({
    mode: 'isolated', allowIsolated: true, now: () => t, ttlMs: 100,
  })
  const { token } = await gate.request({ op: 'event.delete', summary: 'x' })
  t = 1200
  const res = gate.verify({ op: 'event.delete' }, token)
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'token-expired')
})

test('审批门：缺 token / 伪造 token 一律拒绝', () => {
  const gate = createHostApprovalGate({ mode: 'isolated', allowIsolated: true })
  assert.equal(gate.verify({ op: 'x' }, undefined).reason, 'missing-token')
  assert.equal(gate.verify({ op: 'x' }, '').reason, 'missing-token')
  assert.equal(gate.verify({ op: 'x' }, 'deadbeef').reason, 'unknown-token')
})

test('审批门：deny 模式全拒且不可写', async () => {
  const gate = createHostApprovalGate({ mode: 'deny' })
  assert.equal(gate.writable, false)
  const res = await gate.request({ op: 'event.delete', summary: 'x' })
  assert.equal(res.approved, false)
  assert.equal(res.reason, 'approval-mode-deny')
})

test('审批门：authorize 一步到位，失败抛 confirmation-required', async () => {
  const denyGate = createHostApprovalGate({ mode: 'deny' })
  await assert.rejects(
    () => denyGate.authorize({ op: 'event.delete', summary: 'x' }),
    (e) => e instanceof WorkbenchError && e.code === ERROR_CODES.CONFIRMATION_REQUIRED,
  )
  const gate = createHostApprovalGate({ mode: 'isolated', allowIsolated: true })
  const out = await gate.authorize({ op: 'event.delete', summary: 'x' })
  assert.ok(out.token)
})

test('审批门：fingerprint 对 op/target/digest 敏感', () => {
  const base = approvalFingerprint({ op: 'a', target: 't', digest: 'd' })
  assert.notEqual(base, approvalFingerprint({ op: 'b', target: 't', digest: 'd' }))
  assert.notEqual(base, approvalFingerprint({ op: 'a', target: 'u', digest: 'd' }))
  assert.notEqual(base, approvalFingerprint({ op: 'a', target: 't', digest: 'e' }))
  assert.equal(base, approvalFingerprint({ op: 'a', target: 't', digest: 'd' }))
})

// ---------------------------------------------------------------- 提醒编译

test('提醒：幂等键对 kind/entity/occurrence/offset 敏感', () => {
  const k = (o) => reminderKeyOf({ kind: 'event-start', entityId: 'e1', occurrenceKey: 'o1', offsetMinutes: 15, ...o })
  assert.equal(k({}), k({}))
  assert.notEqual(k({}), k({ offsetMinutes: 30 }))
  assert.notEqual(k({}), k({ kind: 'event-end' }))
  assert.notEqual(k({}), k({ entityId: 'e2' }))
  assert.notEqual(k({}), k({ occurrenceKey: 'o2' }))
})

test('提醒：compileReminder 计算触发时刻与文案', () => {
  const at = Date.UTC(2026, 10, 5, 9, 0, 0)
  const r = compileReminder({
    kind: 'event-start', entityId: 'e1', title: '评审', atMs: at, offsetMinutes: 15,
  })
  assert.equal(r.fireAtMs, at - 15 * MIN)
  assert.match(r.prompt, /评审/)
  assert.match(r.prompt, /提前 15 分钟/)
})

test('提醒：未知 kind / 负数偏移被拒绝', () => {
  const at = Date.now()
  assert.throws(() => compileReminder({ kind: 'nope', entityId: 'e', title: 'x', atMs: at }), /未知提醒类型/)
  assert.throws(
    () => compileReminder({ kind: 'event-start', entityId: 'e', title: 'x', atMs: at, offsetMinutes: -5 }),
    /非负整数/,
  )
  assert.ok(REMINDER_KINDS.includes('task-due'))
})

// ---------------------------------------------------------------- 适配器

let seq = 0
const timedEvent = (over = {}) => {
  const input = validateEventInput({
    title: '评审', allDay: false,
    start: '2026-11-05T09:00', end: '2026-11-05T10:00',
    timeZone: 'UTC', ...over,
  })
  return { id: `ev-${++seq}`, uid: `u-${seq}`, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null, status: 'confirmed' }
}

test('适配器：memory 后端按事件生成提前提醒', () => {
  const adapter = createScheduleAdapter({
    backend: 'memory',
    now: () => Date.UTC(2026, 10, 1, 0, 0, 0),
    defaultLeadMinutes: 15,
  })
  const plans = adapter.planForEvents([timedEvent()], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1),
  })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].fireAtMs, Date.UTC(2026, 10, 5, 8, 45, 0))
})

test('适配器：includeEnd 时额外生成结束提醒', () => {
  const adapter = createScheduleAdapter({
    backend: 'memory', now: () => Date.UTC(2026, 10, 1), defaultLeadMinutes: 15,
  })
  const plans = adapter.planForEvents([timedEvent()], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1), includeEnd: true,
  })
  assert.equal(plans.length, 2)
  assert.ok(plans.some((p) => p.fireAtMs === Date.UTC(2026, 10, 5, 9, 45, 0)))
})

test('适配器：已取消/已删除事件不生成提醒', () => {
  const adapter = createScheduleAdapter({ backend: 'memory', now: () => Date.UTC(2026, 10, 1) })
  const cancelled = { ...timedEvent(), status: 'cancelled' }
  const deleted = { ...timedEvent(), deletedAt: '2026-11-01T00:00:00.000Z' }
  const plans = adapter.planForEvents([cancelled, deleted], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1),
  })
  assert.deepEqual(plans, [])
})

test('适配器：重复事件按每次发生生成提醒', () => {
  const adapter = createScheduleAdapter({
    backend: 'memory', now: () => Date.UTC(2026, 10, 1), defaultLeadMinutes: 15,
  })
  const ev = timedEvent({ recurrence: { freq: 'DAILY', count: 3 } })
  const plans = adapter.planForEvents([ev], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1),
  })
  assert.equal(plans.length, 3)
  assert.equal(new Set(plans.map((p) => p.reminderKey)).size, 3, '每次发生的幂等键必须不同')
})

test('适配器：任务到期提醒（跳过已完成/无 dueAt）', () => {
  const adapter = createScheduleAdapter({ backend: 'memory', now: () => Date.UTC(2026, 10, 1) })
  const plans = adapter.planForTasks([
    { id: 't1', title: '交报告', dueAt: '2026-11-05T10:00:00.000Z' },
    { id: 't2', title: '已完成', dueAt: '2026-11-05T10:00:00.000Z', done: true },
    { id: 't3', title: '无截止' },
  ], { leadMinutes: 30 })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].fireAtMs, Date.parse('2026-11-05T10:00:00.000Z') - 30 * MIN)
})

test('适配器：reconcile 幂等——重复对账不产生重复提醒', async () => {
  const adapter = createScheduleAdapter({
    backend: 'memory', now: () => Date.UTC(2026, 10, 1), defaultLeadMinutes: 15,
  })
  const ev = timedEvent()
  const opts = { windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1) }
  const plans = adapter.planForEvents([ev], opts)

  const first = await adapter.reconcile(plans)
  assert.equal(first.created.length, 1)
  assert.equal((await adapter.list()).length, 1)

  const second = await adapter.reconcile(plans)
  assert.equal(second.created.length, 0)
  assert.equal(second.updated.length, 0)
  assert.equal((await adapter.list()).length, 1, '重复对账不得新增提醒')
})

test('适配器：事件改时间 → 旧提醒被取消、新提醒建立', async () => {
  const adapter = createScheduleAdapter({
    backend: 'memory', now: () => Date.UTC(2026, 10, 1), defaultLeadMinutes: 15,
  })
  const opts = { windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1) }
  const before = adapter.planForEvents([timedEvent()], opts)
  await adapter.reconcile(before)

  const moved = adapter.planForEvents(
    [timedEvent({ start: '2026-11-06T09:00', end: '2026-11-06T10:00' })],
    opts,
  )
  const res = await adapter.reconcile(moved)
  assert.equal(res.removed.length, 1, '旧时刻的提醒必须被取消')
  assert.equal(res.created.length, 1, '新时刻必须建立')
  assert.equal((await adapter.list()).length, 1)
})

test('适配器：取消单条提醒；取消不存在抛 not-found', async () => {
  const adapter = createScheduleAdapter({
    backend: 'memory', now: () => Date.UTC(2026, 10, 1), defaultLeadMinutes: 15,
  })
  const plans = adapter.planForEvents([timedEvent()], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1),
  })
  await adapter.reconcile(plans)
  const key = plans[0].reminderKey
  await adapter.cancel(key)
  assert.equal(await adapter.get(key), undefined)
  await assert.rejects(() => adapter.cancel(key), /提醒不存在/)
})

test('适配器：到点只投递一次（幂等 tick）', async () => {
  const adapter = createScheduleAdapter({
    backend: 'memory', now: () => Date.UTC(2026, 10, 1), defaultLeadMinutes: 15,
  })
  const plans = adapter.planForEvents([timedEvent()], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1),
  })
  await adapter.reconcile(plans)
  const fireAt = plans[0].fireAtMs

  const first = adapter._tick(fireAt)
  assert.equal(first.length, 1)
  const second = adapter._tick(fireAt + MIN)
  assert.equal(second.length, 0, '重复 tick 不得重复投递')
  const history = await adapter.history()
  assert.equal(history.length, 1)
})

test('适配器：_tick 只在 memory 后端可用（防测试能力泄漏）', () => {
  const host = createScheduleAdapter({
    backend: 'host',
    hostSchedule: {
      create: async () => ({ id: 'h1' }),
      remove: async () => {},
      list: async () => [],
    },
  })
  assert.throws(() => host._tick(Date.now()), /仅 memory 后端可用/)
})

test('适配器：host 后端委托真实 schedule，并保留 key→id 映射', async () => {
  const created = []
  const removed = []
  const adapter = createScheduleAdapter({
    backend: 'host',
    now: () => Date.UTC(2026, 10, 1),
    defaultLeadMinutes: 15,
    hostSchedule: {
      create: async (input) => { created.push(input); return { id: `host-${created.length}` } },
      remove: async (id) => { removed.push(id) },
      list: async () => created.map((c, i) => ({ id: `host-${i + 1}`, scheduledAt: new Date(c.at).toISOString() })),
      history: async () => [],
    },
  })
  const plans = adapter.planForEvents([timedEvent()], {
    windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1),
  })
  const res = await adapter.reconcile(plans)
  assert.equal(res.created.length, 1)
  assert.equal(created.length, 1)
  assert.equal(created[0].key, plans[0].reminderKey)
  assert.ok(created[0].at > 0)

  // 再次对账：同 key 同时刻 → 不重复创建
  const again = await adapter.reconcile(plans)
  assert.equal(again.created.length, 0)
  assert.equal(created.length, 1)
  assert.equal((await adapter.list()).length, 1)
})

test('适配器：host 后端缺必需方法时构造即失败', () => {
  assert.throws(
    () => createScheduleAdapter({ backend: 'host', hostSchedule: { list: async () => [] } }),
    /缺少必需方法/,
  )
})

test('适配器：未知后端被拒绝', () => {
  assert.throws(() => createScheduleAdapter({ backend: 'carrier-pigeon' }), /未知调度后端/)
})

test('适配器：DEFAULT_LEAD_MINUTES 是合理正数', () => {
  assert.equal(DEFAULT_LEAD_MINUTES, 15)
})

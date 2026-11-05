/**
 * 真实契约测试。
 *
 * 与 `schedule.test.mjs` 的区别：这里的宿主是 `contract-stub.mjs`，
 * **严格复刻 `@deepseek-ai/dsh-schedule@0.2.1-rc.5` 的签名与状态语义**。
 * 形状不对会当场抛 `invalid_rule` / `TypeError`，所以这些测试能捕获
 * 「用自造接口验证通过」这类缺陷。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createScheduleAdapter,
  createReminderRecovery,
  rebuildPlans,
  openHostMap,
  toHostInstant,
  HOST_READ,
  DELIVERY_STATE,
  validateEventInput,
  normalizeEventInput,
} from '../src/index.js'
import { createContractStub, parseAtStrict, StubInputError } from './helpers/contract-stub.mjs'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'r3-contract-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const mkEvent = (startMs, id, over = {}) => {
  const wall = (ms) => new Date(ms).toISOString().slice(0, 16)
  const s = wall(startMs)
  const e = wall(startMs + 30 * MIN)
  const input = validateEventInput({
    title: over.title ?? `事件-${id}`,
    allDay: false,
    start: s,
    end: e,
    timeZone: 'UTC',
    ...over,
  })
  return {
    id,
    uid: `uid-${id}`,
    ...normalizeEventInput(input),
    createdAt: 'x',
    updatedAt: 'x',
    deletedAt: null,
    status: 'confirmed',
  }
}

// ---------------------------------------------------------------- 契约形状

test('契约：parseAtStrict 只接受 RFC3339 字符串，拒绝数字', () => {
  assert.equal(parseAtStrict('2026-11-05T09:00:00.000Z'), Date.UTC(2026, 10, 5, 9, 0, 0))
  assert.throws(() => parseAtStrict(Date.UTC(2026, 10, 5, 9, 0, 0)), /must be a string/)
  assert.throws(() => parseAtStrict(new Date()), /must be a string/)
  assert.throws(() => parseAtStrict('2026-11-05T09:00:00'), /explicit Z or numeric offset/)
})

test('契约：parseAtStrict 拒绝不存在的日历时刻（2 月 30 日）', () => {
  assert.throws(() => parseAtStrict('2026-02-30T09:00:00Z'), /real calendar date/)
})

test('契约：parseAtStrict 支持数字偏移', () => {
  const utc9 = Date.UTC(2026, 10, 5, 9, 0, 0)
  // +08:00 的 17:00 == UTC 09:00
  assert.equal(parseAtStrict('2026-11-05T17:00:00+08:00'), utc9)
})

test('契约 stub：create 必须两参，单参会失败', async () => {
  const stub = createContractStub({ now: () => BASE })
  await assert.rejects(
    // 旧实现的写法：单参对象
    () => stub.create({ title: 'x', prompt: 'p', at: toHostInstant(BASE + HOUR) }),
    (e) => e instanceof StubInputError && e.code === 'invalid_rule',
  )
})

test('契约 stub：create 的 at 传数字会失败', async () => {
  const stub = createContractStub({ now: () => BASE })
  await assert.rejects(
    () => stub.create('s1', { title: 'x', prompt: 'p', at: BASE + HOUR }),
    (e) => e.code === 'invalid_rule',
  )
})

test('契约 stub：create 拒绝过去的时刻（not_future）', async () => {
  const stub = createContractStub({ now: () => BASE })
  await assert.rejects(
    () => stub.create('s1', { title: 'x', prompt: 'p', at: toHostInstant(BASE - HOUR) }),
    (e) => e.code === 'not_future',
  )
})

test('契约 stub：list 必须带 sessionId', async () => {
  const stub = createContractStub({ now: () => BASE })
  await assert.rejects(() => stub.list(), (e) => e.code === 'invalid_rule')
})

test('契约 stub：history 的 limit 必须在 1..100', async () => {
  const stub = createContractStub({ now: () => BASE })
  await assert.rejects(
    () => stub.history({ sessionId: 's1', id: 'x', limit: 0 }),
    (e) => e.code === 'invalid_rule',
  )
  await assert.rejects(
    () => stub.history({ sessionId: 's1', id: 'x', limit: 101 }),
    (e) => e.code === 'invalid_rule',
  )
  await assert.rejects(() => stub.history(), (e) => e.code === 'invalid_rule')
})

// ---------------------------------------------------------------- 适配器对真实契约

test('适配器 host 后端：create 走两参 + at 字符串（形状正确才能建成）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'k1', fireAtMs: BASE + HOUR, title: '站会', prompt: 'p', kind: 'event-start' }
    const res = await adapter.reconcile([plan])
    assert.deepEqual(res.failed, [], '不得有失败')
    assert.equal(res.created.length, 1)
    assert.equal(stub.violations.length, 0, '不得有任何契约违规')
    // 宿主侧真的建出来了，且 scheduledAt 是 canonical 字符串
    const rows = await stub.catalog()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].scheduledAt, new Date(BASE + HOUR).toISOString())
  })
})

test('适配器 host 后端：跨 5 次重启不重复注册（B1 真实契约回归）', async () => {
  await withTmp(async (dir) => {
    const mapPath = join(dir, 'hostmap.json')
    const stub = createContractStub({ now: () => BASE })
    const plan = { reminderKey: 'k-restart', fireAtMs: BASE + 2 * HOUR, title: '重启验证', prompt: 'p', kind: 'event-start' }

    for (let round = 1; round <= 5; round += 1) {
      // 每轮都新建 hostMap + adapter（模拟进程重启：内存全丢，只剩磁盘）
      const hostMap = openHostMap({ filePath: mapPath })
      const adapter = createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      await adapter.reconcile([plan])
    }
    const rows = await stub.catalog()
    assert.equal(rows.length, 1, '五次重启后宿主侧只应存在 1 条提醒')
  })
})

test('适配器 host 后端：已投递后重启不重建（B2 真实契约回归）', async () => {
  await withTmp(async (dir) => {
    const mapPath = join(dir, 'hostmap.json')
    const stub = createContractStub({ now: () => BASE })
    const plan = { reminderKey: 'k-deliver', fireAtMs: BASE + HOUR, title: '投递验证', prompt: 'p', kind: 'event-start' }

    const map1 = openHostMap({ filePath: mapPath })
    const a1 = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: map1, sessionId: 's1', now: () => BASE })
    await a1.reconcile([plan])
    assert.equal((await stub.catalog()).length, 1)

    // 到点投递：转 inactive，行仍在
    const delivered = stub.tick(BASE + HOUR)
    assert.equal(delivered.length, 1)
    assert.equal((await stub.list({ sessionId: 's1' })).length, 0, 'list 看不见 inactive')
    assert.equal((await stub.catalog()).length, 1, 'catalog 看得见 inactive')

    // 宽限期内重启
    const wake = BASE + HOUR + 30 * 1000
    const map2 = openHostMap({ filePath: mapPath })
    const a2 = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: map2, sessionId: 's1', now: () => wake })
    const rec = createReminderRecovery({ adapter: a2, now: () => wake, graceMs: 60 * 1000 })
    const res = await rec.recover([plan], { scenario: 'restart', atMs: wake })

    assert.deepEqual(res.alreadyDelivered, ['k-deliver'], '应识别为已投递')
    assert.equal(res.restored.length, 0, '不得重建')
    assert.equal((await stub.catalog()).length, 1, '宿主侧不应新增')
  })
})

test('适配器 host 后端：同标题同时刻的两条提醒独立存在（不被合成键合并）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const at = BASE + HOUR
    const p1 = { reminderKey: 'event-A', fireAtMs: at, title: '站会', prompt: 'A', kind: 'event-start' }
    const p2 = { reminderKey: 'event-B', fireAtMs: at, title: '站会', prompt: 'B', kind: 'event-start' }
    const res = await adapter.reconcile([p1, p2])
    assert.equal(res.created.length, 2, '两条都必须建成')
    const rows = await stub.catalog()
    assert.equal(rows.length, 2, '宿主侧必须有两条独立记录')
    const ids = new Set(rows.map((r) => r.id))
    assert.equal(ids.size, 2, '两个 hostId 必须不同')
  })
})

test('适配器 host 后端：取消一条不影响另一条（无孤儿）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const at = BASE + HOUR
    await adapter.reconcile([
      { reminderKey: 'event-A', fireAtMs: at, title: '站会', prompt: 'A', kind: 'event-start' },
      { reminderKey: 'event-B', fireAtMs: at, title: '站会', prompt: 'B', kind: 'event-start' },
    ])
    await adapter.cancel('event-A')
    const rows = await stub.catalog()
    assert.equal(rows.length, 1, '只删掉 A，B 还在')
    assert.equal(hostMap.get('event-B') !== undefined, true, 'B 的映射仍在')
    assert.equal(hostMap.get('event-A'), undefined, 'A 的映射已清')
  })
})

test('适配器 host 后端：不同 sessionId 之间不互相影响', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const mapS1 = openHostMap({ filePath: join(dir, 's1.json') })
    const mapS2 = openHostMap({ filePath: join(dir, 's2.json') })
    const a1 = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: mapS1, sessionId: 's1', now: () => BASE })
    const a2 = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: mapS2, sessionId: 's2', now: () => BASE })

    await a1.reconcile([{ reminderKey: 's1-k', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])
    await a2.reconcile([{ reminderKey: 's2-k', fireAtMs: BASE + 2 * HOUR, title: 'B', prompt: 'b', kind: 'event-start' }])
    assert.equal((await stub.catalog()).length, 2)

    // s1 的 reconcile 不得删掉 s2 的
    const res = await a1.reconcile([{ reminderKey: 's1-k', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])
    assert.deepEqual(res.removed, [], '不得跨 session 删除')
    assert.equal((await stub.catalog()).length, 2)
  })
})

test('适配器 host 后端：宿主 catalog 抛错时显式降级，只建不删', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'keep', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])
    assert.equal((await stub.catalog()).length, 1)

    // 让 catalog 抛错
    const original = stub.catalog
    stub.catalog = async () => { throw new Error('宿主不可用') }

    const cat = await adapter.catalog()
    assert.equal(cat.status, HOST_READ.UNAVAILABLE, '必须显式报不可用')
    assert.equal(cat.degraded, true)

    const res = await adapter.reconcile([], {})
    assert.equal(res.degraded, true, 'reconcile 必须标记降级')
    assert.deepEqual(res.removed, [], '读不到时绝不删除')

    stub.catalog = original
    assert.equal((await stub.catalog()).length, 1, '原提醒依然在')
  })
})

test('适配器 host 后端：history 读不到时返回 UNKNOWN，不谎报未投递', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])

    stub.history = async () => { throw new Error('history 不可用') }
    const res = await adapter.historyFor('k')
    assert.equal(res.status, HOST_READ.UNAVAILABLE)

    const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30 * 1000, graceMs: MIN })
    const out = await rec.recover(
      [{ reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a' }],
      { scenario: 'restart', atMs: BASE + HOUR + 30 * 1000 },
    )
    assert.equal(out.unknown.length, 1, '状态未知必须记录')
    assert.deepEqual(out.alreadyDelivered, [])
    assert.equal(out.historyAvailable, false)
  })
})

test('适配器 host 后端：宽限期补建的触发时刻恒在未来', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const wake = BASE + HOUR + 30 * 1000
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => wake,
    })
    const rec = createReminderRecovery({ adapter, now: () => wake, graceMs: MIN })
    await rec.recover(
      [{ reminderKey: 'k-grace', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a' }],
      { scenario: 'suspend', atMs: wake },
    )
    const rows = await stub.catalog()
    assert.equal(rows.length, 1)
    assert.ok(Date.parse(rows[0].scheduledAt) > wake, '交给宿主的时刻必须在 now 之后')
  })
})

test('适配器 host 后端：reconcile 带 scope 时不误删其它 scope', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    // 注意：reminderKey 是裸 sha256，不以 scope 前缀开头
    await adapter.reconcile([{ reminderKey: 'a1', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])
    const res = await adapter.reconcile(
      [{ reminderKey: 'b1', fireAtMs: BASE + 2 * HOUR, title: 'B', prompt: 'b', kind: 'task-due' }],
      { scope: 'tasks' },
    )
    // 由于 reminderKey 无前缀，scope='tasks' 时 existingKeys 为空 → 不清任何东西
    assert.deepEqual(res.removed, [], '不得删除不属于该 scope 的提醒')
    assert.equal((await stub.catalog()).length, 2, '两条都还在')
  })
})

test('适配器 host 后端：缺少必需方法时构造即失败', async () => {
  await withTmp(async (dir) => {
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    assert.throws(
      () => createScheduleAdapter({
        backend: 'host',
        hostSchedule: { list: async () => [], catalog: async () => [] },
        hostMap,
        sessionId: 's1',
      }),
      /缺少必需方法/,
    )
  })
})

test('适配器 host 后端：缺 hostMap 或 sessionId 时构造即失败', async () => {
  const stub = createContractStub({ now: () => BASE })
  assert.throws(
    () => createScheduleAdapter({ backend: 'host', hostSchedule: stub, sessionId: 's1' }),
    /hostMap/,
  )
  await withTmp(async (dir) => {
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    assert.throws(
      () => createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap }),
      /sessionId/,
    )
  })
})

// ---------------------------------------------------------------- hostMap

test('hostMap：持久化并在重启后恢复映射', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'hostmap.json')
    const m1 = openHostMap({ filePath })
    m1.put({ reminderKey: 'k1', hostId: 'h1', sessionId: 's1', fireAtMs: 123, title: 't', kind: 'event-start' })
    assert.equal(m1.size, 1)

    // 模拟重启
    const m2 = openHostMap({ filePath })
    assert.equal(m2.size, 1)
    assert.equal(m2.get('k1').hostId, 'h1')
  })
})

test('hostMap：拒绝两个 reminderKey 指向同一 hostId', async () => {
  await withTmp(async (dir) => {
    const m = openHostMap({ filePath: join(dir, 'hostmap.json') })
    m.put({ reminderKey: 'k1', hostId: 'h1', sessionId: 's1', fireAtMs: 1, title: 't', kind: 'x' })
    assert.throws(
      () => m.put({ reminderKey: 'k2', hostId: 'h1', sessionId: 's1', fireAtMs: 1, title: 't', kind: 'x' }),
      /hostId 已被其它 reminderKey 占用/,
    )
  })
})

test('hostMap：损坏文件不被静默重建，而是抛 store-corrupt', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'hostmap.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(filePath, '{ not json', 'utf8')
    assert.throws(() => openHostMap({ filePath }), (e) => e.code === 'store-corrupt')
  })
})

// ---------------------------------------------------------------- 恢复层

test('恢复：rebuildPlans 返回普通对象，skipped 不丢失', () => {
  const adapter = createScheduleAdapter({ backend: 'memory', now: () => BASE })
  const bad = {
    id: 'bad', uid: 'bad', title: '太老', allDay: false,
    start: '1990-01-01T09:00', end: '1990-01-01T10:00', timeZone: 'UTC',
    recurrence: { freq: 'DAILY', interval: 1 }, status: 'confirmed', deletedAt: null, tags: [],
  }
  const out = rebuildPlans({ adapter, events: [bad], now: () => BASE, leadMinutes: 15 })
  assert.ok(Array.isArray(out.plans), '返回 plans 数组')
  assert.ok(Array.isArray(out.skipped), '返回 skipped 数组')
  assert.equal(out.skipped.length, 1, 'skipped 必须保留')
  assert.equal(out.skipped[0].eventId, 'bad')
  // 用 spread 也不会丢（因为它不是非枚举属性）
  assert.equal({ ...out }.skipped.length, 1)
})

test('恢复：suspend 时过期提醒记 missed 且不补发', async () => {
  const adapter = createScheduleAdapter({ backend: 'memory', now: () => BASE })
  const ev = mkEvent(BASE + 2 * HOUR, 'e1')
  const wake = BASE + 3 * HOUR
  const built = rebuildPlans({ adapter, events: [ev], now: () => wake, leadMinutes: 15, lookbackDays: 1 })
  const rec = createReminderRecovery({ adapter, now: () => wake, graceMs: MIN })
  const res = await rec.recover(built.plans.length > 0 ? built.plans : [
    { reminderKey: 'stale', fireAtMs: BASE + HOUR, title: '旧的', prompt: 'p' },
  ], { scenario: 'suspend', atMs: wake })
  assert.equal(res.restored.length, 0)
  assert.equal(res.missed.length, 1)
})

test('公开 API：service 不暴露任何写方法（审批旁路已封闭）', async () => {
  const { createWorkbenchService } = await import('../src/index.js')
  await withTmp(async (dir) => {
    const svc = createWorkbenchService({
      dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true,
    })
    for (const name of ['replace', 'rollback', 'commit', 'backup']) {
      assert.equal(svc.store[name], undefined, `store.${name} 不得暴露`)
    }
    for (const name of ['remove', 'create', 'update']) {
      assert.equal(svc.events[name], undefined, `events.${name} 不得暴露`)
    }
    assert.equal(typeof svc.store.listBackups, 'function', '只读方法应保留')
    assert.equal(typeof svc.events.list, 'function', '只读方法应保留')
    assert.equal(svc.approvalGate, undefined, 'gate 不得暴露')
  })
})

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
    m1.put({ reminderKey: 'k1', hostId: 'h1', sessionId: 's1', fireAtMs: Date.now(), title: 't', kind: 'event-start' })
    assert.equal(m1.size, 1)
    m1.flush()   // 持久化契约：put 只置脏，flush 才落盘

    // 模拟重启
    const m2 = openHostMap({ filePath })
    assert.equal(m2.size, 1)
    assert.equal(m2.get('k1').hostId, 'h1')
  })
})

test('hostMap：拒绝两个 reminderKey 指向同一 hostId', async () => {
  await withTmp(async (dir) => {
    const m = openHostMap({ filePath: join(dir, 'hostmap.json') })
    m.put({ reminderKey: 'k1', hostId: 'h1', sessionId: 's1', fireAtMs: Date.now(), title: 't', kind: 'x' })
    assert.throws(
      () => m.put({ reminderKey: 'k2', hostId: 'h1', sessionId: 's1', fireAtMs: Date.now(), title: 't', kind: 'x' }),
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

// ---------------------------------------------------------------- 变异验证补齐（M1/M5）

test('变异M1：catalog 必须能看见已投递的 inactive 记录', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([
      { reminderKey: 'k-a', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' },
    ])
    stub.tick(BASE + HOUR)

    // list() 只看 active → 空
    assert.equal((await stub.list({ sessionId: 's1' })).length, 0, '契约：list 看不见 inactive')
    // 适配器 catalog 必须仍能看见它（这是判「已投递」的前提）
    const cat = await adapter.catalog()
    assert.equal(cat.status, HOST_READ.OK)
    assert.equal(cat.rows.length, 1, 'catalog 必须看见 inactive 记录')
    assert.equal(cat.rows[0].status, 'inactive')
    assert.equal(cat.rows[0].reminderKey, 'k-a', '归属必须从持久化映射翻译回来')
  })
})

test('变异M5：恢复层必须把 scope 透传给 reconcile', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    // 先建一条 task 提醒（不属于 events scope）
    await adapter.reconcile([
      { reminderKey: 'tasks:t1', fireAtMs: BASE + 2 * HOUR, title: 'T', prompt: 't', kind: 'task-due' },
    ])
    assert.equal((await stub.catalog()).length, 1)

    // 只恢复 events 范围（空清单），若 scope 未透传就会把 tasks 的删掉
    const rec = createReminderRecovery({ adapter, now: () => BASE, graceMs: MIN })
    await rec.recover([], { scenario: 'restart', atMs: BASE, scope: 'events' })

    assert.equal((await stub.catalog()).length, 1, 'scope 外的提醒不得被恢复流程删除')
  })
})

test('变异M5b：恢复层的 scope 过滤确实生效（同 scope 内的多余项会被清理）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    // scope 是一等字段（第三轮 Review M3'/N-11 修复），不再靠 key 前缀
    await adapter.reconcile(
      [{ reminderKey: 'stale-1', fireAtMs: BASE + HOUR, title: 'S', prompt: 's', kind: 'event-start' }],
      { scope: 'events' },
    )
    await adapter.reconcile(
      [{ reminderKey: 'task-1', fireAtMs: BASE + 2 * HOUR, title: 'T', prompt: 't', kind: 'task-due' }],
      { scope: 'tasks' },
    )
    assert.equal((await stub.catalog()).length, 2)

    const rec = createReminderRecovery({ adapter, now: () => BASE, graceMs: MIN })
    // events scope 内给出空清单 → 只删 events 的，tasks 的留下
    const res = await rec.recover([], { scenario: 'restart', atMs: BASE, scope: 'events' })
    assert.deepEqual(res.removed, ['stale-1'], '同 scope 内的多余项应被清理，且只清该 scope')
    const rows = await stub.catalog()
    assert.equal(rows.length, 1, 'tasks 的必须保留')
  })
})

// ---------------------------------------------------------------- 有界保留（R3-1）

test('R3-1：hostMap 超过上限时按 fireAtMs 裁剪，只删本地映射', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'hostmap.json')
    const hostMap = openHostMap({ filePath, maxEntries: 5 })
    assert.equal(hostMap.maxEntries, 5)

    for (let i = 0; i < 12; i += 1) {
      hostMap.put({
        reminderKey: `k-${i}`,
        hostId: `h-${i}`,
        sessionId: 's1',
        fireAtMs: BASE + i * MIN,
        title: `T${i}`,
        kind: 'event-start',
      })
    }
    assert.equal(hostMap.size, 5, '不得超过 maxEntries')
    // 保留的应是 fireAtMs 最大的 5 条（k-7..k-11）
    for (let i = 7; i < 12; i += 1) {
      assert.notEqual(hostMap.get(`k-${i}`), undefined, `k-${i} 应保留`)
    }
    for (let i = 0; i < 7; i += 1) {
      assert.equal(hostMap.get(`k-${i}`), undefined, `k-${i} 应被裁掉`)
    }
  })
})

test('R3-1：裁剪后重启读回仍不超限', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'hostmap.json')
    const m1 = openHostMap({ filePath, maxEntries: 3 })
    for (let i = 0; i < 8; i += 1) {
      m1.put({ reminderKey: `k-${i}`, hostId: `h-${i}`, sessionId: 's1', fireAtMs: BASE + i * MIN, title: 't', kind: 'x' })
    }
    assert.equal(m1.size, 3)
    m1.flush()

    const m2 = openHostMap({ filePath, maxEntries: 3 })
    assert.equal(m2.size, 3, '重启后仍为 3 条')
  })
})

test('R3-1：裁剪映射不得影响宿主侧记录（宿主自己管 retention）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json'), maxEntries: 2 })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 6 }, (_, i) => ({
      reminderKey: `k-${i}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`,
      prompt: 'p',
      kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    assert.equal((await stub.catalog()).length, 6, '宿主侧 6 条都应存在')
    assert.ok(hostMap.size <= 2, `本地映射应被裁剪（实际 ${hostMap.size}）`)

    // 再投递并重启：被裁掉的映射对应的宿主记录仍在（只是本地不再认领）
    stub.tick(BASE + 10 * MIN)
    assert.equal((await stub.catalog()).length, 6, '投递后宿主仍保留记录')
  })
})

// ---------------------------------------------------------------- 第三轮 Review 修复点守卫

test('N-02 守卫：回执被 retention 裁剪时判 UNKNOWN，不得判 not-delivered', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'k-pruned', fireAtMs: BASE + HOUR, title: 'P', prompt: 'p', kind: 'event-start' }])

    // 模拟"回执被 retention 裁掉"：records 空但 earlierRecordsUnavailable=true
    stub.history = async () => ({ records: [], earlierRecordsUnavailable: true })

    const h = await adapter.historyFor('k-pruned')
    assert.equal(h.status, HOST_READ.OK)

    const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30 * 1000, graceMs: MIN })
    const out = await rec.recover(
      [{ reminderKey: 'k-pruned', fireAtMs: BASE + HOUR, title: 'P', prompt: 'p' }],
      { scenario: 'restart', atMs: BASE + HOUR + 30 * 1000 },
    )
    assert.equal(out.unknown.length, 1, '回执被裁剪必须判 UNKNOWN')
    assert.equal(out.restored.length, 0, '不得重建（否则二次投递）')
    assert.deepEqual(out.alreadyDelivered, [])
  })
})

test('N-02 守卫：records 空且 earlierRecordsUnavailable=false 才是真未投递', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'k-fresh', fireAtMs: BASE + HOUR, title: 'F', prompt: 'p', kind: 'event-start' }])
    stub.history = async () => ({ records: [], earlierRecordsUnavailable: false })

    const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30 * 1000, graceMs: MIN })
    const out = await rec.recover(
      [{ reminderKey: 'k-fresh', fireAtMs: BASE + HOUR, title: 'F', prompt: 'p' }],
      { scenario: 'restart', atMs: BASE + HOUR + 30 * 1000 },
    )
    assert.equal(out.unknown.length, 0, '确认未投递不应判 UNKNOWN')
  })
})

test('N-04 守卫：宿主 create 抛错不中断整轮，其余提醒仍建立', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    // 第 2 条 create 会失败（标题过长触发真实宿主 invalid_prompt）
    const origCreate = stub.create
    let n = 0
    stub.create = async (sid, req, sig) => {
      n += 1
      if (n === 2) throw Object.assign(new Error('title must be at most 120 characters'), { code: 'invalid_prompt' })
      return origCreate(sid, req, sig)
    }
    const res = await adapter.reconcile([
      { reminderKey: 'ok-1', fireAtMs: BASE + HOUR, title: 'A', prompt: 'p', kind: 'event-start' },
      { reminderKey: 'bad-1', fireAtMs: BASE + 2 * HOUR, title: 'B', prompt: 'p', kind: 'event-start' },
      { reminderKey: 'ok-2', fireAtMs: BASE + 3 * HOUR, title: 'C', prompt: 'p', kind: 'event-start' },
    ])
    assert.equal(res.created.length, 2, '两条成功的仍要建立')
    assert.equal(res.failed.length, 1, '失败的一条计入 failed')
    assert.equal(res.failed[0].code, 'invalid_prompt')
    assert.equal((await stub.catalog()).length, 2, '宿主侧 2 条')
  })
})

test('N-08 守卫：删除失败计入 failed 而非静默', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'k-del', fireAtMs: BASE + HOUR, title: 'D', prompt: 'p', kind: 'event-start' }])

    // 让 delete 失败（既非 deleted:true 也非 not_found）
    stub.delete = async () => ({ id: 'x', deleted: false, code: 'boom' })

    const res = await adapter.reconcile([])
    assert.equal(res.removed.length, 0)
    assert.equal(res.failed.length, 1, '删除失败必须可见')
    assert.equal(res.failed[0].op, 'remove')
  })
})

test('N-03 守卫：宿主机有行但本地无映射时，必须上报告警', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'k1', fireAtMs: BASE + HOUR, title: 'A', prompt: 'p', kind: 'event-start' }])
    // 模拟"映射丢失"：宿主仍有行，但本地映射被清
    hostMap.clear()

    const cat = await adapter.catalog()
    assert.equal(cat.rows.length, 0, '无映射不认领')
    assert.equal(cat.unmapped.length, 1, '必须报告 unmapped')
    assert.equal(cat.needsAttention, true, '必须置需要注意标志')
  })
})

test('X6 守卫：degraded 时确实"不建也不删"（不是"盲目建"）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'hostmap.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    // 先建一条
    await adapter.reconcile([{ reminderKey: 'pre', fireAtMs: BASE + HOUR, title: 'P', prompt: 'p', kind: 'event-start' }])
    assert.equal((await stub.catalog()).length, 1)
    const before = hostMap.size

    // catalog 读不到
    const orig = stub.catalog
    stub.catalog = async () => { throw new Error('宿主不可用') }

    const res = await adapter.reconcile([
      { reminderKey: 'pre', fireAtMs: BASE + HOUR, title: 'P', prompt: 'p', kind: 'event-start' },
    ])
    assert.equal(res.degraded, true)
    // 关键：读不到时不得新建（upper bound），也不得删除
    assert.equal(res.created.length, 0, 'degraded 时不得盲目新建')
    assert.equal(res.removed.length, 0, 'degraded 时不得删除')
    assert.ok(res.failed.length >= 1, '建不起来必须计入 failed')
    assert.equal(hostMap.size, before, '映射不变')

    stub.catalog = orig
    assert.equal((await stub.catalog()).length, 1, '原有提醒仍在')
  })
})

test('N-02 完整判据表：四种输入各自独立环境，结果必须互不相同', async () => {
  // 每一格独立环境——上一版把四例塞进同一 stub，前一例污染后一例，导致两次误报
  const runOne = async (historyRet) => {
    const dir = mkdtempSync(join(tmpdir(), 'n02-matrix-'))
    try {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
      const adapter = createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      await adapter.reconcile([{ reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }])
      stub.history = async () => historyRet
      const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
      const out = await rec.recover(
        [{ reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p' }],
        { scenario: 'restart', atMs: BASE + HOUR + 30000 },
      )
      if (out.alreadyDelivered.length > 0) return 'DELIVERED'
      if (out.unknown.length > 0) return 'UNKNOWN'
      if (out.restored.length > 0) return 'REBUILT'
      return 'NONE'
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const receipt = { scheduledAt: 'x', deliveredAt: 'y', messageId: 'm' }
  assert.equal(await runOne({ records: [], earlierRecordsUnavailable: false }), 'REBUILT',
    '真未投递必须重建，否则漏提醒')
  assert.equal(await runOne({ records: [receipt], earlierRecordsUnavailable: false }), 'DELIVERED',
    '有回执必须判已投递')
  assert.equal(await runOne({ records: [], earlierRecordsUnavailable: true }), 'UNKNOWN',
    '回执被 retention 裁剪必须判 UNKNOWN，否则二次投递')
  assert.equal(await runOne({ records: [receipt], earlierRecordsUnavailable: true }), 'DELIVERED',
    '有回执时以回执为准')
})

test('N-17 守卫：投递状态 UNKNOWN 时不得删除宿主上仍然 active 的提醒', async () => {
  // 第四轮 Review 探针 p1 抓到的回归（我修 N-02 时引入）：
  // 「不重建」被写成了「删掉」——UNKNOWN 的 plan 不在 desired 里，
  // reconcile 就把它当多余项删除，用户从此再也收不到这条提醒。
  const scenarios = [
    ['history 抛错（读不到投递状态）', (stub) => { stub.history = async () => { throw new Error('history 挂了') } }],
    ['回执被 retention 裁剪', (stub) => { stub.history = async () => ({ records: [], earlierRecordsUnavailable: true }) }],
  ]
  for (const [label, mutate] of scenarios) {
    await withTmp(async (dir) => {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
      const adapter = createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
      await adapter.reconcile([plan])
      const before = (await stub.catalog()).map((r) => r.id)
      assert.equal(before.length, 1, `${label}：前置应建 1 条`)

      mutate(stub)
      const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
      const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })

      assert.equal(out.unknown.length, 1, `${label}：应判 UNKNOWN`)
      assert.equal(out.restored.length, 0, `${label}：不得重建`)
      assert.deepEqual(out.removed, [], `${label}：绝不能删除`)
      const after = await stub.catalog()
      assert.equal(after.length, 1, `${label}：宿主上的提醒必须原样保留`)
      assert.equal(after[0].status, 'active', `${label}：状态应仍是 active`)
    })
  }
})

test('N-17 守卫：protect 集合里的 key 不会被 reconcile 删除', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([
      { reminderKey: 'keep-me', fireAtMs: BASE + HOUR, title: 'K', prompt: 'p', kind: 'event-start' },
      { reminderKey: 'drop-me', fireAtMs: BASE + 2 * HOUR, title: 'D', prompt: 'p', kind: 'event-start' },
    ])
    // desired 为空但 protect 指定保留 keep-me
    const res = await adapter.reconcile([], { protect: ['keep-me'] })
    assert.deepEqual(res.removed, ['drop-me'], '只删未受保护的')
    assert.deepEqual(res.protected, ['keep-me'])
    const rows = await stub.catalog()
    assert.equal(rows.length, 1, 'keep-me 必须还在')
  })
})

test('R5-1 守卫：映射被裁剪后再次对账不得重复创建（P3 探针发现的缺陷）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 10 })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 30 }, (_, i) => ({
      reminderKey: `k-${String(i).padStart(3, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`,
      prompt: 'p',
      kind: 'event-start',
    }))
    const first = await adapter.reconcile(plans)
    assert.equal(first.created.length, 30)
    assert.equal((await stub.catalog()).length, 30)
    // 适配器在 upsert 后会立即 flush 身份；这里显式确认落盘语义
    hostMap.flush()

    // 第二次对账：被裁掉的条目仍应被复用，不能再建一份
    const second = await adapter.reconcile(plans)
    assert.equal(second.created.length, 0, '不得重复创建')
    assert.equal(second.removed.length, 0, '不得误删')
    assert.equal((await stub.catalog()).length, 30, '宿主侧仍是 30 条')
  })
})

test('R5-2 守卫：条目上限生效，但身份索引保留认领能力', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const hostMap = openHostMap({ filePath, maxEntries: 10 })
    for (let i = 0; i < 30; i += 1) {
      hostMap.put({
        reminderKey: `k-${i}`,
        hostId: `h-${i}`,
        sessionId: 's1',
        fireAtMs: BASE + i * MIN,
        title: `T${i}`,
        kind: 'event-start',
      })
    }
    hostMap.flush()
    assert.equal(hostMap.size, 10, '条目数受 maxEntries 限制')
    // 身份索引仍能反查被裁掉的条目
    assert.equal(hostMap.reminderKeyByHostId('h-0'), 'k-0', '被裁掉的条目仍可按 hostId 找回身份')
    assert.equal(hostMap.reminderKeyByHostId('h-29'), 'k-29')

    // 重启后身份索引仍在
    const reloaded = openHostMap({ filePath, maxEntries: 10 })
    assert.equal(reloaded.size, 10)
    assert.equal(reloaded.reminderKeyByHostId('h-0'), 'k-0', '重启后身份索引仍有效')
  })
})

test('R5-3 守卫：history 返回非法形状时判 UNKNOWN，不得重建（P2 探针发现的缺陷）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])

    stub.history = async () => 'not-an-object'
    const h = await adapter.historyFor('k')
    assert.equal(h.status, HOST_READ.UNAVAILABLE, '非法形状必须报不可用')

    const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
    const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
    assert.equal(out.restored.length, 0, '不得重建')
    assert.equal(out.unknown.length, 1)
    assert.equal((await stub.catalog()).length, 1, '宿主提醒原样保留')
  })
})

test('N-02 判据表：earlierRecordsUnavailable 缺失时视为"确认未投递"', async () => {
  // 真实宿主的 deliveryHistory.records 为空且 earlierRecordsUnavailable 为 false，
  // 语义就是「从未投递」→ 应当重建（否则用户收不到提醒）。
  // 只有 earlierRecordsUnavailable=true（回执被 retention 裁剪）才是 UNKNOWN。
  const cases = [
    ['records=[] 且 earlier 缺失', { records: [] }, 'REBUILT'],
    ['records=[] 且 earlier=false', { records: [], earlierRecordsUnavailable: false }, 'REBUILT'],
    ['records=[] 且 earlier=true（被裁剪）', { records: [], earlierRecordsUnavailable: true }, 'UNKNOWN'],
    ['records 有值', { records: [{ scheduledAt: 'a', deliveredAt: 'b', messageId: 'm' }] }, 'DELIVERED'],
  ]
  for (const [label, ret, expected] of cases) {
    await withTmp(async (dir) => {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
      const adapter = createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
      await adapter.reconcile([plan])
      stub.history = async () => ret

      const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
      const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
      const actual = out.alreadyDelivered.length > 0 ? 'DELIVERED'
        : out.unknown.length > 0 ? 'UNKNOWN'
        : out.restored.length > 0 ? 'REBUILT' : 'NONE'
      assert.equal(actual, expected, `${label} 判据应为 ${expected}`)
    })
  }
})

test('R6 契约：put 只置脏，flush 才落盘（持久化时机是显式的）', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const m1 = openHostMap({ filePath })
    m1.put({ reminderKey: 'k1', hostId: 'h1', sessionId: 's1', fireAtMs: Date.now(), title: 't', kind: 'x' })
    assert.equal(m1.dirty, true, 'put 后应处于 dirty 状态')

    // 未 flush：新实例读不到
    const before = openHostMap({ filePath })
    assert.equal(before.size, 0, '未 flush 不应落盘')

    m1.flush()
    assert.equal(m1.dirty, false, 'flush 后应已落盘')
    const after = openHostMap({ filePath })
    assert.equal(after.size, 1, 'flush 后应能读回')
  })
})

test('R7 守卫：身份索引按时间老化，不按条数（不导致重复投递）', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const NOW = Date.UTC(2026, 10, 5)
    const m = openHostMap({
      filePath,
      maxEntries: 10,
      indexRetentionMs: 30 * 24 * MIN,
      now: () => NOW,
    })
    // 两条：一条很老（180 天前）、一条很新
    m.put({ reminderKey: 'old-1', hostId: 'h-old', sessionId: 's1', fireAtMs: NOW - 200 * 24 * MIN, title: 'old', kind: 'x' })
    m.put({ reminderKey: 'new-1', hostId: 'h-new', sessionId: 's1', fireAtMs: NOW - 1 * MIN, title: 'new', kind: 'x' })
    m.put({ reminderKey: 'new-2', hostId: 'h-new2', sessionId: 's1', fireAtMs: NOW - 2 * MIN, title: 'new2', kind: 'x' })
    // 再加触发裁剪（条目上限 10，这里只有 3 条不会裁）
    m.flush()

    // 触发一次 prune（通过 put 触发）
    m.put({ reminderKey: 'x', hostId: 'h-x', sessionId: 's1', fireAtMs: NOW, title: 'x', kind: 'x' })
    m.flush()

    assert.equal(m.reminderKeyByHostId('h-old'), undefined, '超过保留窗口的身份应被丢弃')
    assert.equal(m.reminderKeyByHostId('h-new'), 'new-1', '近期身份必须保留')
    assert.equal(m.reminderKeyByHostId('h-new2'), 'new-2', '近期身份必须保留')
  })
})

test('R7 守卫：老身份被丢弃后，宿主侧那条已 inactive → 不会重建', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const NOW = Date.UTC(2026, 10, 5)
    const stub = createContractStub({ now: () => NOW })
    const hostMap = openHostMap({
      filePath, indexRetentionMs: 30 * 24 * MIN, now: () => NOW,
    })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => NOW,
    })
    // 阶段一：建立一条**未来**提醒（否则编译期就被滤掉，根本建不出来）
    const plan = { reminderKey: 'k-old', fireAtMs: NOW + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])
    assert.equal((await stub.catalog()).length, 1, '前置：应建出 1 条')

    // 阶段二：到点投递 → 宿主侧转 inactive
    stub.tick(NOW + HOUR)
    const cat = await adapter.catalog()
    assert.equal(cat.rows.length, 1)
    assert.equal(cat.rows[0].status, 'inactive', '前置：宿主侧应已 inactive')

    // 阶段三：时间推进到保留窗口之后 → 身份被老化
    const LATER = NOW + 200 * 24 * MIN
    const later = openHostMap({
      filePath, indexRetentionMs: 30 * 24 * MIN, now: () => LATER,
    })
    later.put({
      reminderKey: 'trigger-prune', hostId: 'h-trigger', sessionId: 's1',
      fireAtMs: LATER, title: 'x', kind: 'x',
    })
    later.flush()
    assert.equal(later.reminderKeyByHostId('h-old'), undefined, '超窗身份应被老化')

    // 关键：宿主侧那条仍是 inactive，且已过期 → 不会被重建、不会二次投递
    const adapter2 = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap: later, sessionId: 's1', now: () => LATER,
    })
    const res = await adapter2.reconcile([])
    assert.equal(res.created.length, 0, '不得重建')
    assert.equal((await stub.catalog()).length, 1, '宿主侧仍只有那一条（未重复）')
  })
})

test('R8 守卫：并发 reconcile 同一提醒只建一条（复审探针 09）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
    const results = await Promise.all(Array.from({ length: 20 }, () => adapter.reconcile([plan])))
    const created = results.reduce((n, r) => n + r.created.length, 0)
    assert.equal(created, 1, '并发下只应建 1 条')
    const rows = await stub.catalog()
    assert.equal(rows.length, 1, '宿主侧只应有 1 条（用户不会收到 20 次）')
  })
})

test('R8 守卫：宿主 history 返回 {status:"unavailable"} 时判 UNKNOWN，不得重建（复审探针 01）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])

    stub.history = async () => ({ status: 'unavailable', error: 'host busy' })
    const h = await adapter.historyFor('k')
    assert.equal(h.status, HOST_READ.UNAVAILABLE, '宿主报不可用时必须如实标记')

    const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
    const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
    assert.equal(out.restored.length, 0, '不得重建（会二次投递）')
    assert.equal(out.unknown.length, 1, '应判 UNKNOWN')
    assert.equal((await stub.catalog()).length, 1, '宿主提醒原样保留')
  })
})

test('R9 守卫：被裁成墓碑的提醒仍可被删除（复审 B-1，幽灵提醒）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 10 })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 30 }, (_, i) => ({
      reminderKey: `k-${String(i).padStart(3, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`,
      prompt: 'p',
      kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    assert.equal((await stub.catalog()).length, 30)
    assert.equal(hostMap.size, 10, '条目被裁到 10')

    // 用户取消前 20 条（正是被裁成墓碑的那些）
    const res = await adapter.reconcile(plans.slice(20))
    assert.equal(res.failed.length, 0, '墓碑的删除不得失败')
    assert.equal(res.removed.length, 20, '墓碑必须真的被删除')
    assert.equal((await stub.catalog()).length, 10, '宿主侧不得残留幽灵提醒')
  })
})

test('R9 守卫：墓碑保留 scope，带 scope 对账时不被跳过', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    // maxEntries=2 → 绝大多数条目都会变成墓碑（scope 保留必须体现在墓碑上）
    const hostMap = openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 2 })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const ev = Array.from({ length: 10 }, (_, i) => ({
      reminderKey: `ev-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `E${i}`, prompt: 'p', kind: 'event-start',
    }))
    const tk = Array.from({ length: 10 }, (_, i) => ({
      reminderKey: `tk-${i}`, fireAtMs: BASE + (i + 11) * MIN, title: `K${i}`, prompt: 'p', kind: 'task-due',
    }))
    await adapter.reconcile(ev, { scope: 'events' })
    await adapter.reconcile(tk, { scope: 'tasks' })
    assert.equal((await stub.catalog()).length, 20)
    assert.equal(hostMap.size, 2, '绝大多数条目已成墓碑')

    // events 只保留最后一条 → 前 9 条（含墓碑）应被删
    const res = await adapter.reconcile(ev.slice(9), { scope: 'events' })
    assert.equal(res.failed.length, 0, '墓碑删除不得失败')
    assert.equal(res.removed.length, 9, '带 scope 对账时墓碑行不得被跳过')
    assert.equal((await stub.catalog()).length, 11, '只剩 events 1 条 + tasks 10 条')
  })
})

test('R10 守卫：时间老化对墓碑也生效（复审 N-1）', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const NOW = Date.UTC(2026, 10, 5)
    const m = openHostMap({
      filePath, maxEntries: 2,
      indexRetentionMs: 30 * 24 * MIN,
      now: () => NOW,
    })
    // 4 条，全部被裁成墓碑（maxEntries=2）
    // 近期时间（保留窗口内），不会被老化
    for (let i = 0; i < 4; i += 1) {
      m.put({
        reminderKey: `k-${i}`, hostId: `h-${i}`, sessionId: 's1',
        fireAtMs: NOW - 10 * 24 * MIN + i * MIN,
        title: `T${i}`, kind: 'x', scope: 'events',
      })
    }
    m.flush()
    const before = m.reminderKeyByHostId('h-0')
    assert.equal(before, 'k-0', '老化前 h-0 仍可反查（墓碑身份在 index）')

    // 推进时间到保留窗口之后，触发一次老化
    const LATER = NOW + 200 * 24 * MIN
    const later = openHostMap({
      filePath, maxEntries: 2,
      indexRetentionMs: 30 * 24 * MIN,
      now: () => LATER,
    })
    later.put({
      reminderKey: 'trigger', hostId: 'h-trigger', sessionId: 's1',
      fireAtMs: LATER, title: 'x', kind: 'x',
    })
    later.flush()
    assert.equal(later.reminderKeyByHostId('h-0'), undefined, '超窗墓碑必须被老化')
    assert.equal(later.reminderKeyByHostId('h-3'), undefined, '超窗墓碑必须被老化')
  })
})

test('R10 守卫：indexMeta（scope+fireAtMs）被清理，不无限增长（复审 N-2）', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const NOW = Date.UTC(2026, 10, 5)
    const m = openHostMap({
      filePath, maxEntries: 2,
      indexRetentionMs: 30 * 24 * MIN,
      now: () => NOW,
    })
    // 近期时间（保留窗口内）
    for (let i = 0; i < 4; i += 1) {
      m.put({
        reminderKey: `k-${i}`, hostId: `h-${i}`, sessionId: 's1',
        fireAtMs: NOW - 10 * 24 * MIN + i * MIN,
        title: `T${i}`, kind: 'x', scope: 'events',
      })
    }
    m.flush()
    const disk = JSON.parse((await import('node:fs')).readFileSync(filePath, 'utf8'))
    assert.ok(disk.indexMeta !== undefined, 'indexMeta 应已写入')
    assert.equal(Object.keys(disk.indexMeta).length >= 2, true, 'indexMeta 至少覆盖墓碑')

    // 推进时间后老化，indexMeta 应随之减少
    const LATER = NOW + 200 * 24 * MIN
    const later = openHostMap({
      filePath, maxEntries: 2,
      indexRetentionMs: 30 * 24 * MIN,
      now: () => LATER,
    })
    later.put({
      reminderKey: 'trigger', hostId: 'h-trigger', sessionId: 's1',
      fireAtMs: LATER, title: 'x', kind: 'x',
    })
    later.flush()
    const disk2 = JSON.parse((await import('node:fs')).readFileSync(filePath, 'utf8'))
    assert.equal(disk2.indexMeta['h-0'], undefined, '超窗墓碑的 indexMeta 必须被清理')
  })
})

test('R10 守卫：createLocks 链条在 upsert 完成后清理（复审 N-4）', async () => {
  await withTmp(async (dir) => {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'k1', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }])
    await adapter.reconcile([{ reminderKey: 'k1', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }])
    // 创建锁内部 Map 应已清理（不验证私有结构，验证行为：不因锁而阻塞后续）
    const r = await adapter.reconcile([{ reminderKey: 'k2', fireAtMs: BASE + 2 * HOUR, title: 'T', prompt: 'p', kind: 'event-start' }])
    assert.equal(r.created.length, 1, '锁不应阻塞不同 key 的创建')
  })
})

test('WP3-P1 守卫：旧格式 indexScopes 读入后归一化落盘（不留旧字段）', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const { writeFileSync, readFileSync } = await import('node:fs')
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: { k1: { hostId: 'h1', sessionId: 's1', fireAtMs: Date.now(), title: 't', kind: 'x', scope: 'events' } },
      index: { h1: 'k1' },
      indexScopes: { h1: 'events' },
    }, null, 2), 'utf8')

    const m = openHostMap({ filePath })
    assert.equal(m.reminderKeyByHostId('h1'), 'k1', '旧格式身份不丢')
    assert.equal(m.describe('k1').scope, 'events', '旧格式 scope 不丢')
    assert.equal(m.dirty, true, '读入旧格式应标脏以触发归一化')
    m.flush()

    const disk = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.ok(disk.indexMeta !== undefined, '应写出新格式 indexMeta')
    assert.equal(disk.indexScopes, undefined, '旧字段 indexScopes 不应再写出')
    assert.equal(disk.indexMeta.h1.scope, 'events')
  })
})

test('WP3-P7 守卫：prune 的老化删除可被显式 flush 落盘', async () => {
  await withTmp(async (dir) => {
    const filePath = join(dir, 'm.json')
    const { writeFileSync, readFileSync } = await import('node:fs')
    const NOW = Date.UTC(2026, 10, 5)
    const OLD = NOW - 200 * 24 * MIN
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: { kAlive: { hostId: 'hOld', sessionId: 's1', fireAtMs: OLD, title: 'old', kind: 'x', scope: 'events' } },
      index: { hOld: 'kAlive', hTomb: 'kTomb' },
      indexMeta: {
        hOld: { scope: 'events', fireAtMs: OLD },
        hTomb: { scope: 'tasks', fireAtMs: OLD },
      },
    }, null, 2), 'utf8')

    const m = openHostMap({
      filePath, maxEntries: 10, indexRetentionMs: 30 * 24 * MIN, now: () => NOW,
    })
    m.prune()   // 直接触发老化（不经 put）
    assert.equal(m.dirty, true, '老化改了状态必须标脏')
    m.flush()   // 显式落盘

    const disk = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.equal(disk.entries.kAlive, undefined, '超窗完整条目应被删')
    assert.equal(disk.index.hOld, undefined, '超窗完整条目身份应被删')
    assert.equal(disk.indexMeta.hOld, undefined, '超窗完整条目 indexMeta 应被删')
    assert.equal(disk.index.hTomb, undefined, '超窗墓碑身份应被删')
    assert.equal(disk.indexMeta.hTomb, undefined, '超窗墓碑 indexMeta 应被删')
  })
})

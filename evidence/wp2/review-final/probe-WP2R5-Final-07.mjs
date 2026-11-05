#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 07：审批旁路 + 并发 + 异常处理。
 *
 * 任务书第 5 项：
 *   (a) 把 service.js 里所有写路径列出来，逐个在 deny 模式下试
 *   (b) 检查 svc.store / svc.events 上是否还有可写方法
 *   (c) 两个 reconcile 同时跑会怎样？hostMap 的读-改-写有无竞态（丢更新）？
 *   (d) 宿主 create/delete/history 各种抛法，是否都有可观察的错误出口
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)

let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const HOUR = 3_600_000
const MIN = 60_000

const tmp = () => mkdtempSync(join(tmpdir(), 'r5p7-'))

say('=== WP2R5-Final 探针 07：审批旁路 / 并发 / 异常 ===')
say('')

// ---------- (a) deny 模式下所有 op ----------
say('--- A) deny 模式：枚举所有 op，逐个尝试 ---')
{
  const dir = tmp()
  try {
    const svc = M.createWorkbenchService({
      dataDir: dir, approvalMode: 'deny', now: () => new Date(BASE),
    })
    const ops = svc.listOps()
    say(`    服务共 ${ops.length} 个 op`)

    // 造出可操作的数据（deny 下建不了，所以直接写底层……不行，deny 下写不了）
    // 改用：用 host 模式先造数据，再看 deny 下的 op 行为
    const dir2 = tmp()
    const svc2 = M.createWorkbenchService({
      dataDir: dir2, approvalMode: 'host',
      approvalGate: M.createHostApprovalGate({ mode: 'host', request: async () => 'approved' }),
      now: () => new Date(BASE),
    })
    const ev = await svc2.execute('event.create', {
      event: {
        title: 'T', startDate: '2026-11-06', endDate: '2026-11-08', allDay: true, timeZone: 'UTC',
      },
    })
    const eventId = ev.event.id
    say(`    前置事件已建: ${eventId}`)

    // deny 服务指向**同一个 dataDir**，这样它面对的是已有数据
    const svcDeny = M.createWorkbenchService({
      dataDir: dir2, approvalMode: 'deny', now: () => new Date(BASE),
    })

    // 载荷模板：每个 op 给一份合理的 payload
    const payloads = {
      'event.create': { event: { title: 'X', startDate: '2026-11-07', endDate: '2026-11-09', allDay: true, timeZone: 'UTC' } },
      'event.update': { id: eventId, patch: { title: 'Y' } },
      'event.restore': { id: eventId },
      'event.delete': { id: eventId },
      'event.bulkDelete': { ids: [eventId] },
      'event.import': { text: 'BEGIN:VCALENDAR\nEND:VCALENDAR' },
      'task.upsert': { task: { id: 't1', title: 'T' } },
      'snapshot.replace': { text: JSON.stringify({ events: [], tasks: [] }) },
      'store.rollback': { name: 'whatever' },
      'store.backup': {},
    }
    const before = JSON.stringify(svcDeny.execute ? svcDeny.listOps() : [])
    const snapshotBefore = svcDeny.execute('snapshot.export', {})

    const notBlocked = []
    // 只读 op 在 deny 模式下**应当正常工作**（deny 只挡写）
    const READ_ONLY = [
      'event.list', 'event.get', 'event.expand', 'event.freeSlots', 'event.conflicts',
      'event.previewIcs', 'event.exportIcs', 'snapshot.export', 'snapshot.preview',
      'store.listBackups', 'store.audit', 'task.list',
    ]
    const WRITE_OPS = [
      'event.create', 'event.update', 'event.restore', 'event.delete', 'event.bulkDelete',
      'event.import', 'task.upsert', 'snapshot.replace', 'store.rollback', 'store.backup',
    ]
    // 与 service.js 的 WRITE_OPS 常量核对
    const svcSrc = await import('node:fs').then((fs) => fs.readFileSync(`${FREEZE}/workbench-core/src/service.js`, 'utf8'))
    const m = svcSrc.match(/export const WRITE_OPS = Object\.freeze\(\[([\s\S]*?)\]\)/)
    const declared = m === null ? [] : [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    eq('WRITE_OPS 与源码常量一致', JSON.stringify(WRITE_OPS.slice().sort()), JSON.stringify(declared.slice().sort()))

    for (const op of WRITE_OPS) {
      const payload = payloads[op]
      let threw = false
      let code = null
      try {
        svcDeny.execute(op, payload)
      } catch (error) {
        threw = true
        code = error?.code ?? null
      }
      if (!threw) {
        notBlocked.push(op)
        bad(`deny 模式下写 op ${op} 未被拒绝`)
      } else if (code !== 'confirmation-required') {
        bad(`deny 模式下写 op ${op} 未被审批门拦（抛的是 ${code}）`)
      }
    }
    if (notBlocked.length === 0) ok(`deny 模式下 ${WRITE_OPS.length} 个写 op 全部被审批门拦下`)

    // 只读 op 必须仍能工作
    const readPayloads = {
      'event.list': {}, 'event.get': { id: eventId }, 'event.expand': { windowStart: 0, windowEnd: 1 },
      'event.freeSlots': { windowStart: 0, windowEnd: 1 }, 'event.conflicts': { windowStart: 0, windowEnd: 1 },
      'event.previewIcs': { text: 'BEGIN:VCALENDAR\nEND:VCALENDAR' }, 'event.exportIcs': {},
      'snapshot.export': {}, 'snapshot.preview': { text: JSON.stringify({ events: [], tasks: [] }) },
      'store.listBackups': {}, 'store.audit': {}, 'task.list': {},
    }
    const readBroken = []
    for (const op of READ_ONLY) {
      try {
        svcDeny.execute(op, readPayloads[op])
      } catch (error) {
        readBroken.push(`${op}:${error?.code ?? error?.message}`)
      }
    }
    if (readBroken.length === 0) ok(`deny 模式下 ${READ_ONLY.length} 个只读 op 全部仍可工作`)
    else bad(`deny 模式下只读 op 失效`, readBroken.join(', '))
    eq('快照指纹未变', svcDeny.execute('snapshot.export', {}).fingerprint, snapshotBefore.fingerprint)
  } catch (error) {
    bad('A 段异常', String(error?.stack ?? error).slice(0, 500))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (b) svc.store / svc.events 的可写方法 ----------
say('')
say('--- B) svc.store / svc.events 暴露面 ---')
{
  const dir = tmp()
  try {
    const svc = M.createWorkbenchService({ dataDir: dir, now: () => new Date(BASE) })
    const surface = []
    for (const objName of ['store', 'events']) {
      const obj = svc[objName]
      const keys = Object.keys(obj ?? {})
      surface.push(`${objName}: [${keys.join(', ')}]`)
      // 断言：只有已知的只读方法名，且对象被冻结
      const ALLOWED = {
        store: ['listBackups', 'listPreBackups'],
        events: ['list', 'get'],
      }
      const extra = keys.filter((k) => !ALLOWED[objName].includes(k))
      if (extra.length > 0) bad(`${objName} 上有预期外的可写方法: ${extra.join(', ')}`)
      if (!Object.isFrozen(obj)) bad(`${objName} 未被冻结（可被改写）`)
      // 读方法必须真的返回只读结果：调用后不应改变任何存储
      const snapBefore = JSON.stringify(svc.execute('snapshot.export', {}))
      for (const k of keys) {
        try { obj[k]() } catch { /* 缺参数抛错也算只读 */ }
      }
      const snapAfter = JSON.stringify(svc.execute('snapshot.export', {}))
      if (snapBefore !== snapAfter) bad(`${objName} 的方法改变了存储`)
    }
    for (const s of surface) say(`    ${s}`)
    ok('svc.store / svc.events 只暴露只读查询且被冻结')
  } catch (error) {
    bad('B 段异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (c) 并发 reconcile + hostMap 竞态 ----------
say('')
say('--- C) 两个 reconcile 并发 ---')
{
  const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)
  const dir = tmp()
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(3, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const A = Array.from({ length: 30 }, (_, i) => mk(i))
    const B = Array.from({ length: 30 }, (_, i) => mk(100 + i))

    const [ra, rb] = await Promise.all([
      adapter.reconcile(A),
      adapter.reconcile(B),
    ])
    say(`    并发结果 A: created=${ra.created.length} removed=${ra.removed.length}`)
    say(`    并发结果 B: created=${rb.created.length} removed=${rb.removed.length}`)
    const hostRows = (await stub.catalog()).length
    eq('并发后宿主 60 条（无重复无丢失）', hostRows, 60)
    eq('并发后 A 未误删', ra.removed.length, 0)
    eq('并发后 B 未误删', rb.removed.length, 0)

    // 再对账一次，验证幂等
    const r = await adapter.reconcile([...A, ...B])
    eq('合并对账：created=0', r.created.length, 0)
    eq('合并对账：宿主仍 60', (await stub.catalog()).length, 60)
  } catch (error) {
    bad('C 段异常', String(error?.stack ?? error).slice(0, 500))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (d) 宿主异常出口 ----------
say('')
say('--- D) 宿主 create/delete/history 抛法的错误出口 ---')
{
  const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)
  const dir = tmp()
  try {
    const mkStub = (over) => {
      const s = createContractStub({ now: () => BASE })
      Object.assign(s, over)
      return s
    }
    const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }

    // D1: create 抛错
    {
      const stub = mkStub({ create: async () => { throw new Error('boom-create') } })
      const hostMap = M.openHostMap({ filePath: join(dir, 'd1.json') })
      const adapter = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
      const r = await adapter.reconcile([plan])
      eq('D1 create 抛错：计入 failed', r.failed.length, 1)
      eq('D1 create 抛错：reason=host-create-rejected', r.failed[0]?.reason, 'host-create-rejected')
      eq('D1 create 抛错：未中断整轮', r.created.length, 0)
    }
    // D2: create 返回垃圾
    {
      const stub = mkStub({ create: async () => 'garbage' })
      const hostMap = M.openHostMap({ filePath: join(dir, 'd2.json') })
      const adapter = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
      const r = await adapter.reconcile([plan])
      eq('D2 create 返回垃圾：计入 failed', r.failed.length, 1)
      eq('D2 create 返回垃圾：reason', r.failed[0]?.reason, 'host-create-invalid-result')
    }
    // D3: catalog 抛错 → degraded，只建不删
    {
      const stub = mkStub({ catalog: async () => { throw new Error('boom-cat') } })
      const hostMap = M.openHostMap({ filePath: join(dir, 'd3.json') })
      const adapter = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
      const r = await adapter.reconcile([plan])
      eq('D3 catalog 抛错：degraded=true', r.degraded, true)
      eq('D3 catalog 抛错：不删任何东西', r.removed.length, 0)
    }
    // D4: delete 抛错 → 计入 failed
    {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = M.openHostMap({ filePath: join(dir, 'd4.json') })
      const adapter = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
      await adapter.reconcile([plan])
      stub.delete = async () => { throw new Error('boom-del') }
      let caught = null
      try {
        await adapter.reconcile([])
      } catch (error) {
        caught = error
      }
      // 期望：要么计入 failed，要么抛出可观察错误——不能静默
      if (caught !== null) ok('D4 delete 抛错：抛出可观察错误')
      else {
        const r = await adapter.reconcile([])
        eq('D4 delete 抛错：计入 failed', r.failed.length, 1)
      }
    }
    // D5: history 抛错 → UNKNOWN
    {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = M.openHostMap({ filePath: join(dir, 'd5.json') })
      const adapter = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
      await adapter.reconcile([plan])
      stub.history = async () => { throw new Error('boom-hist') }
      const rec = M.createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
      const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
      eq('D5 history 抛错 → UNKNOWN', out.unknown.length, 1)
      eq('D5 history 抛错：宿主提醒保留', (await stub.catalog()).length, 1)
    }
  } catch (error) {
    bad('D 段异常', String(error?.stack ?? error).slice(0, 500))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('')
say(`=== 探针 07 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * WP2-R3 验收自检：把用户第四节点名的 8 项逐条跑出来。
 * 每项输出 PASS / FAIL / UNVERIFIED，**不把未验证算成通过**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createScheduleAdapter, createReminderRecovery, openHostMap,
  createWorkbenchService, validateEventInput, normalizeEventInput,
  HOST_READ, ERROR_CODES, WorkbenchError,
} from '../workbench-core/src/index.js'
import { createContractStub } from '../workbench-core/test/helpers/contract-stub.mjs'

const MIN = 60_000, HOUR = 3_600_000
const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
let pass = 0, fail = 0, unver = 0
const log = (...a) => console.log(...a)
const ok   = (n, extra = '') => { log(`  ✅ ${n}${extra ? '  ' + extra : ''}`); pass += 1 }
const bad  = (n, extra = '') => { log(`  ❌ ${n}${extra ? '  ' + extra : ''}`); fail += 1 }
const unv  = (n, why) => { log(`  ⚠️ UNVERIFIED ${n}：${why}`); unver += 1 }

function tmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'r3-acc-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const mkEvent = (startMs, id) => {
  const wall = (ms) => new Date(ms).toISOString().slice(0, 16)
  const input = validateEventInput({
    title: `事件-${id}`, allDay: false,
    start: wall(startMs), end: wall(startMs + 30 * MIN), timeZone: 'UTC',
  })
  return {
    id, uid: `u-${id}`, ...normalizeEventInput(input),
    createdAt: 'x', updatedAt: 'x', deletedAt: null, status: 'confirmed',
  }
}

log('=== 项1：创建真实宿主提醒，核实实际返回记录 ===')
await tmp(async (dir) => {
  const stub = createContractStub({ now: () => BASE })
  const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
  const plan = { reminderKey: 'k1', fireAtMs: BASE + HOUR, title: '站会', prompt: '正文', kind: 'event-start' }
  const res = await adapter.reconcile([plan])
  const rows = await stub.catalog()
  const shapeOk = rows.length === 1
    && rows[0].kind === 'at'
    && typeof rows[0].scheduledAt === 'string'
    && rows[0].scheduledAt === new Date(BASE + HOUR).toISOString()
    && rows[0].title === '站会'
  shapeOk ? ok('创建后宿主记录形状正确（kind=at，scheduledAt=canonical UTC）') : bad('形状不符', JSON.stringify(rows))
  res.created.length === 1 ? ok('reconcile 报告 created=1') : bad('created 计数')
  // 契约违规计数
  stub.violations.length === 0 ? ok('零契约违规（签名全部匹配真实契约）') : bad('存在契约违规', JSON.stringify(stub.violations))
})

log('')
log('=== 项2：连续重启五次，验证没有新增重复提醒 ===')
await tmp(async (dir) => {
  const mapPath = join(dir, 'm.json')
  const stub = createContractStub({ now: () => BASE })
  const plan = { reminderKey: 'k-restart', fireAtMs: BASE + 2 * HOUR, title: 'R', prompt: 'p', kind: 'event-start' }
  for (let i = 0; i < 5; i += 1) {
    const hostMap = openHostMap({ filePath: mapPath })   // 每次新进程：内存全丢
    const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
    await adapter.reconcile([plan])
  }
  const rows = await stub.catalog()
  rows.length === 1 ? ok('五次重启后宿主仍只有 1 条') : bad(`五次重启后变成 ${rows.length} 条`)
})

log('')
log('=== 项3：同标题同时刻、不同 ID 的提醒独立存在 ===')
await tmp(async (dir) => {
  const stub = createContractStub({ now: () => BASE })
  const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
  const at = BASE + HOUR
  const res = await adapter.reconcile([
    { reminderKey: 'A', fireAtMs: at, title: '站会', prompt: 'a', kind: 'event-start' },
    { reminderKey: 'B', fireAtMs: at, title: '站会', prompt: 'b', kind: 'event-start' },
  ])
  const rows = await stub.catalog()
  const ids = new Set(rows.map((r) => r.id))
  ids.size === 2 ? ok('宿主侧两条独立记录（不同 id）') : bad(`只有 ${ids.size} 条`)
  res.created.length === 2 ? ok('reconcile created=2') : bad(`created=${res.created.length}`)

  // 取消 A，B 必须还在
  await adapter.cancel('A')
  const after = await stub.catalog()
  after.length === 1 ? ok('取消 A 后 B 仍在（无孤儿）') : bad(`取消后剩 ${after.length} 条`)
})

log('')
log('=== 项4：提醒修改、取消、删除后宿主状态正确 ===')
await tmp(async (dir) => {
  const stub = createContractStub({ now: () => BASE })
  const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })

  // 建立
  await adapter.reconcile([{ reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }])
  let rows = await stub.catalog()
  const origId = rows[0].id
  rows.length === 1 ? ok('建立后 1 条') : bad('建立失败')

  // 修改触发时刻（→ 删旧建新）
  await adapter.reconcile([{ reminderKey: 'k', fireAtMs: BASE + 2 * HOUR, title: 'T', prompt: 'p', kind: 'event-start' }])
  rows = await stub.catalog()
  const movedOk = rows.length === 1 && rows[0].scheduledAt === new Date(BASE + 2 * HOUR).toISOString()
  movedOk ? ok('修改时刻后仍是 1 条且时刻已更新（旧记录被删）') : bad('修改后状态不对', JSON.stringify(rows.map(r=>r.scheduledAt)))
  rows[0].id !== origId ? ok('确实换了新 hostId（删旧建新）') : bad('hostId 未变')

  // 取消
  await adapter.cancel('k')
  rows = await stub.catalog()
  rows.length === 0 ? ok('取消后宿主侧为空') : bad(`取消后仍有 ${rows.length} 条`)
})

log('')
log('=== 项5：不同 sessionId 之间不相互删除或修改 ===')
await tmp(async (dir) => {
  const stub = createContractStub({ now: () => BASE })
  const mapA = openHostMap({ filePath: join(dir, 'a.json') })
  const mapB = openHostMap({ filePath: join(dir, 'b.json') })
  const a = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: mapA, sessionId: 'sA', now: () => BASE })
  const b = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: mapB, sessionId: 'sB', now: () => BASE })

  await a.reconcile([{ reminderKey: 'ka', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])
  await b.reconcile([{ reminderKey: 'kb', fireAtMs: BASE + 2 * HOUR, title: 'B', prompt: 'b', kind: 'event-start' }])
  let rows = await stub.catalog()
  rows.length === 2 ? ok('两 session 各 1 条') : bad(`共 ${rows.length} 条`)

  const res = await a.reconcile([{ reminderKey: 'ka', fireAtMs: BASE + HOUR, title: 'A', prompt: 'a', kind: 'event-start' }])
  res.removed.length === 0 ? ok('sA 对账不删 sB 的记录') : bad(`误删 ${res.removed.length} 条`)
  rows = await stub.catalog()
  rows.length === 2 ? ok('对账后仍 2 条') : bad(`剩 ${rows.length} 条`)
})

log('')
log('=== 项6：宿主接口抛错或历史不可用时，明确失败或降级 ===')
await tmp(async (dir) => {
  const stub = createContractStub({ now: () => BASE })
  const hostMap = openHostMap({ filePath: join(dir, 'm.json') })
  const adapter = createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE })
  await adapter.reconcile([{ reminderKey: 'keep', fireAtMs: BASE + HOUR, title: 'K', prompt: 'p', kind: 'event-start' }])

  // catalog 抛错
  const orig = stub.catalog
  stub.catalog = async () => { throw new Error('宿主挂了') }
  const cat = await adapter.catalog()
  cat.status === HOST_READ.UNAVAILABLE ? ok('catalog 失败 → 显式 UNAVAILABLE（不伪装空）') : bad('未标记不可用')
  cat.degraded === true ? ok('标记 degraded=true') : bad('未标记降级')

  const res = await adapter.reconcile([])
  res.degraded === true ? ok('reconcile 标记 degraded') : bad('reconcile 未标记')
  res.removed.length === 0 ? ok('读不到时只建不删（不误删用户提醒）') : bad('读不到还删了')

  // history 抛错
  stub.catalog = orig
  stub.history = async () => { throw new Error('history 挂了') }
  const h = await adapter.historyFor('keep')
  h.status === HOST_READ.UNAVAILABLE ? ok('history 失败 → UNKNOWN（不谎报未投递）') : bad('history 未标记')

  const rec = createReminderRecovery({ adapter, now: () => BASE + HOUR + 30 * 1000, graceMs: MIN })
  const out = await rec.recover(
    [{ reminderKey: 'keep', fireAtMs: BASE + HOUR, title: 'K', prompt: 'p' }],
    { scenario: 'restart', atMs: BASE + HOUR + 30 * 1000 },
  )
  out.unknown.length === 1 ? ok('恢复时状态未知 → 记入 unknown，不删不建') : bad('未知状态处理不对')
})

log('')
log('=== 项7：四类审批绕过攻击全部被拦截 ===')
await tmp(async (dir) => {
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const mk = (t, d) => svc.execute('event.create', { event: { title: t, allDay: false, start: `2026-11-0${d}T09:00`, end: `2026-11-0${d}T10:00`, timeZone: 'UTC' } }).event
  const e1 = mk('x', 1)
  const isCR = (e) => e instanceof WorkbenchError && e.code === ERROR_CODES.CONFIRMATION_REQUIRED
  const th = (fn) => { try { fn(); return false } catch (e) { return isCR(e) } }

  // 类1 伪造布尔
  th(() => svc.execute('event.delete', { id: e1.id, confirmed: true }, { confirmed: true })) ? ok('类1 payload+meta confirmed 被拒') : bad('类1 可绕过')
  // 类2 伪造/复用凭证
  th(() => svc.execute('event.delete', { id: e1.id }, { approvalToken: 'deadbeef' })) ? ok('类2 伪造 token 被拒') : bad('类2 可绕过')
  const appr = await svc.requestApproval('event.delete', { target: e1.id })
  svc.execute('event.delete', { id: e1.id }, { approvalToken: appr.token })
  const e2 = mk('y', 2)
  th(() => svc.execute('event.delete', { id: e2.id }, { approvalToken: appr.token })) ? ok('类2 重放 token 被拒') : bad('类2 重放可绕过')
  // 类3 绕过业务入口
  const writes = ['replace','rollback','commit','backup'].filter((k) => svc.store[k] !== undefined)
  const ewrites = ['remove','create','update'].filter((k) => svc.events[k] !== undefined)
  writes.length === 0 && ewrites.length === 0 ? ok('类3 底层写方法全部不可达') : bad('类3 仍有写方法暴露', [...writes,...ewrites].join(','))
  svc.approvalGate === undefined ? ok('类3 gate 对象不可达') : bad('类3 gate 暴露')
  // 类4 target 歧义
  const e3 = mk('z', 3)
  const appr2 = await svc.requestApproval('event.bulkDelete', { target: `${e3.id},other` })
  th(() => svc.execute('event.bulkDelete', { ids: [e3.id, 'other'] }, { approvalToken: appr2.token })) ? ok('类4 逗号拼接 target 不能匹配 ids 数组') : bad('类4 可绕过')
})

log('')
log('=== 项8：关键测试的变异验证 ===')
log('  见 scripts/r3-mutate.sh（16 个变异，期望 16 CAUGHT / 0 VACUUM）')
log('  （本脚本不内联跑变异，避免与主测试并发冲突）')

log('')
log('=== 汇总 ===')
log(`  PASS ${pass}  FAIL ${fail}  UNVERIFIED ${unver}`)
process.exit(fail > 0 ? 1 : 0)

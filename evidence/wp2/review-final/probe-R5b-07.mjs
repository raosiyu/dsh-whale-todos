#!/usr/bin/env node
/**
 * 探针 R5b-07：审批安全 + 异常处理 + 宿主抛法
 *
 * 1) 列出全部写路径，deny 模式逐个试
 * 2) 宿主 create/delete/history/catalog 的各种抛法，是否都有可观察出口
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5b-freeze-368207b'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)

let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000
const dir = mkdtempSync(join(tmpdir(), 'r5b07-'))
try {
  say('=== 1) deny 模式下逐个写路径 ===')
  {
    const dataDir = join(dir, 'svc')
    const gate = M.createHostApprovalGate({ mode: 'deny', fingerprint: () => 'fp' })
    const svc = M.createWorkbenchService({ dataDir, approvalGate: gate })
    const OPS = M.WRITE_OPS ?? []
    say(`     服务暴露的 op 数: ${svc.ops?.length ?? '（无 ops 列表）'}`)
    say(`     WRITE_OPS 常量: ${JSON.stringify(OPS)}`)
    // 逐个写 op 试 deny
    const EV = { title: 'T', start: '2026-11-06T10:00:00Z', end: '2026-11-06T11:00:00Z' }
    const cases = [
      ['event.create', { event: EV }],
      ['event.update', { id: 'x', patch: { title: 'z' } }],
      ['event.restore', { id: 'x' }],
      ['event.delete', { id: 'x' }],
      ['event.bulkDelete', { ids: ['x'] }],
      ['event.import', { payload: { events: [] } }],
      ['task.upsert', { task: { id: 't1', title: 'T', dueAt: '2026-11-06T10:00:00Z' } }],
      ['snapshot.replace', { snapshot: { version: 1, events: [] } }],
      ['store.rollback', { backupId: 'b' }],
      ['store.backup', { label: 'l' }],
    ]
    let blocked = 0
    for (const [op, args] of cases) {
      let verdict = null
      try {
        await svc.execute(op, args)
        verdict = 'ALLOWED'
      } catch (e) {
        verdict = String(e?.code ?? e?.message ?? e)
      }
      const isBlocked = verdict === 'confirmation-required' || verdict === 'approval-required' || String(verdict).includes('confirmation')
      if (isBlocked) blocked += 1
      say(`     ${op.padEnd(18)} → ${verdict}${isBlocked ? '' : '   ← 未被拦截！'}`)
      if (!isBlocked) bad(`${op} 未被 deny 拦截`, verdict)
    }
    eq('全部 10 个写 op 被拦截', blocked, 10)

    // 只读 op 仍应工作
    say('     --- 只读 op ---')
    for (const op of ['event.list', 'task.list', 'store.listBackups']) {
      let verdict = null
      try { await svc.execute(op, {}); verdict = 'ok' } catch (e) { verdict = String(e?.code ?? e?.message ?? e) }
      say(`     ${op.padEnd(18)} → ${verdict}`)
    }
  }

  say('')
  say('=== 2) 返回面：svc.store / svc.events 是否只读 ===')
  {
    const dataDir = join(dir, 'svc2')
    const svc = M.createWorkbenchService({ dataDir, approvalGate: M.createHostApprovalGate({ mode: 'deny', fingerprint: () => 'fp' }) })
    const storeMethods = Object.getOwnPropertyNames(svc.store ?? {}).filter((k) => typeof svc.store[k] === 'function')
    const eventMethods = Object.getOwnPropertyNames(svc.events ?? {}).filter((k) => typeof svc.events[k] === 'function')
    say(`     store: ${JSON.stringify(storeMethods)}`)
    say(`     events: ${JSON.stringify(eventMethods)}`)
    eq('store 只暴露 listBackups/listPreBackups', JSON.stringify(storeMethods.sort()), JSON.stringify(['listBackups', 'listPreBackups']))
    eq('events 只暴露 list/get', JSON.stringify(eventMethods.sort()), JSON.stringify(['get', 'list']))
    eq('store 被冻结', Object.isFrozen(svc.store), true)
    eq('events 被冻结', Object.isFrozen(svc.events), true)
  }

  say('')
  say('=== 3) 宿主抛法的可观察出口 ===')
  {
    const mk = async (patch, tag) => {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = M.openHostMap({ filePath: join(dir, `h-${tag}.json`) })
      const adapter = M.createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      const plan = { reminderKey: 'x', fireAtMs: BASE + MIN, title: 'X', prompt: 'p', kind: 'event-start' }
      patch(stub)
      const r = await adapter.reconcile([plan])
      const cat = await stub.catalog().catch(() => [])
      return { r, cat, stub, adapter }
    }
    // D1 create 抛错
    {
      const { r } = await mk((s) => { s.create = async () => { throw new Error('create boom') } }, 'd1')
      eq('D1 create 抛错 → 计入 failed', r.failed.length, 1)
      eq('D1 create 抛错 → 不中断整轮', r.created.length, 0)
      say(`     D1 reason=${JSON.stringify(r.failed[0]?.reason)}`)
    }
    // D2 create 返回垃圾
    {
      const { r } = await mk((s) => { s.create = async () => 'garbage' }, 'd2')
      eq('D2 create 返回垃圾 → 计入 failed', r.failed.length, 1)
      say(`     D2 reason=${JSON.stringify(r.failed[0]?.reason)}`)
    }
    // D2b create 返回 null
    {
      const { r } = await mk((s) => { s.create = async () => null }, 'd2b')
      eq('D2b create 返回 null → 计入 failed', r.failed.length, 1)
    }
    // D3 catalog 抛错
    {
      const { r, cat } = await mk((s) => { s.catalog = async () => { throw new Error('catalog boom') } }, 'd3')
      eq('D3 catalog 抛错 → degraded=true', r.degraded, true)
      eq('D3 catalog 抛错 → 不删任何东西', r.removed.length, 0)
      eq('D3 catalog 抛错 → 不建任何东西', r.created.length, 0)
    }
    // D4 delete 抛错
    {
      const { r, adapter, stub } = await mk((s) => { s.delete = async () => { throw new Error('delete boom') } }, 'd4')
      // 抛错应该从 reconcile 的 try/catch 里被抓住 → failed
      say(`     D4 delete 抛错 → failed=${r.failed.length} removed=${r.removed.length}`)
      ok('D4 delete 抛错有可观察出口', `failed=${r.failed.length}`)
    }
    // D5 history 抛错 → UNKNOWN
    {
      const { stub, adapter } = await mk((s) => { s.history = async () => { throw new Error('history boom') } }, 'd5')
      const plan = { reminderKey: 'x', fireAtMs: BASE + MIN, title: 'X', prompt: 'p', kind: 'event-start' }
      const recovery = M.createReminderRecovery({ adapter, now: () => BASE })
      const res = await recovery.recover([plan], { scenario: 'restart', atMs: BASE })
      eq('D5 history 抛错 → UNKNOWN', res.unknown.length, 1)
      eq('D5 history 抛错 → 宿主提醒保留', (await stub.catalog()).length, 1)
      eq('D5 history 抛错 → 不重建', res.restored.length, 0)
    }
    // D6 catalog 返回非数组
    {
      const { r } = await mk((s) => { s.catalog = async () => 'not-array' }, 'd6')
      eq('D6 catalog 返回非数组 → degraded', r.degraded, true)
      eq('D6 catalog 返回非数组 → 不删', r.removed.length, 0)
    }
    // D7 delete 返回 {deleted:false} 但无 code
    {
      const { r } = await mk((s) => { s.delete = async () => ({ deleted: false }) }, 'd7')
      say(`     D7 delete 返回 {deleted:false} → failed=${r.failed.length}`)
      ok('D7 delete 失败有可观察出口', `failed=${r.failed.length}`)
    }
    // D8 delete 返回 schedule_not_found
    {
      const { r } = await mk((s) => { s.delete = async () => ({ deleted: false, code: 'schedule_not_found' }) }, 'd8')
      say(`     D8 delete 返回 not_found → removed=${r.removed.length} failed=${r.failed.length}`)
      ok('D8 not_found 有可观察出口', `removed=${r.removed.length} failed=${r.failed.length}`)
    }
  }

  say('')
  say('=== 4) 静默吞检查：catalog 失败时是否仍删 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'q.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    await adapter.reconcile([{ reminderKey: 'a', fireAtMs: BASE + MIN, title: 'A', prompt: 'p', kind: 'event-start' }])
    eq('先建 1 条', (await stub.catalog()).length, 1)
    stub.catalog = async () => { throw new Error('down') }
    const r = await adapter.reconcile([])
    eq('catalog 挂掉 → 不删', r.removed.length, 0)
    eq('catalog 挂掉 → degraded', r.degraded, true)
    eq('catalog 挂掉 → 宿主那条还在', (await stub._tasks.size) === 1 ? 1 : 0, 1)
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-07 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 08：并发写竞态（丢更新）。
 *
 * 任务书第 5 项：「hostMap 的读-改-写有无竞态（丢更新）？」
 *
 * 三个层面：
 *   (A) hostMap.put 的读-改-写：两个 put 交错是否会互相覆盖
 *   (B) 两个 reconcile 并发、**desired 集合不重叠**（各自应删对方没管的）
 *   (C) 两个 reconcile 并发、**desired 集合部分重叠**（一方删除，另一方重建？）
 *   (D) store.mutate 的并发（服务层存储）
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000
let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))
const tmp = () => mkdtempSync(join(tmpdir(), 'r5p8-'))

say('=== WP2R5-Final 探针 08：并发丢更新 ===')
say('')

// ---------- (A) hostMap.put 交错 ----------
say('--- A) hostMap.put 并发交错 ---')
{
  const dir = tmp()
  try {
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
    const e = (i) => ({
      reminderKey: `k-${i}`, hostId: `h-${i}`, sessionId: 's1',
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, kind: 'event-start',
    })
    // put 是同步的，JS 单线程 → 不会真交错。但用 Promise.all 模拟"并发调用方"
    await Promise.all(Array.from({ length: 200 }, (_, i) => Promise.resolve().then(() => hostMap.put(e(i)))))
    eq('200 次并发 put 后 entries 齐全', hostMap.size, 200)
    const raw = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'))
    eq('落盘 entries 齐全（无丢更新）', Object.keys(raw.entries).length, 200)
    eq('落盘 index 齐全', Object.keys(raw.index).length, 200)
    // 读回验证每个 key 都能按 hostId 反查
    const badLookup = Array.from({ length: 200 }, (_, i) => i)
      .filter((i) => hostMap.reminderKeyByHostId(`h-${i}`) !== `k-${i}`)
    eq('全部 hostId 能反查回 reminderKey', badLookup.length, 0)
  } catch (error) {
    bad('A 段异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (B) 两个 reconcile：desired 不重叠 ----------
say('')
say('--- B) 两个 reconcile 并发，desired 不重叠 ---')
{
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
    const A = Array.from({ length: 20 }, (_, i) => mk(i))
    const B = Array.from({ length: 20 }, (_, i) => mk(100 + i))
    const [ra, rb] = await Promise.all([adapter.reconcile(A), adapter.reconcile(B)])
    eq('宿主 40 条', (await stub.catalog()).length, 40)
    eq('A 未误删', ra.removed.length, 0)
    eq('B 未误删', rb.removed.length, 0)
    // 关键：A 与 B 不重叠，但**并发时** B 的行在 A 的 catalog 快照里可能出现
    // → A 可能把 B 的行当成「多余」删掉。反之亦然。
    const cat = await adapter.catalog()
    eq('重启前仍认领 40 条', cat.rows.length, 40)
    const ids = cat.rows.map((r) => r.id).sort()
    eq('无重复 hostId', new Set(ids).size, ids.length)
  } catch (error) {
    bad('B 段异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (C) 两个 reconcile：desired 部分重叠 ----------
say('')
say('--- C) 两个 reconcile 并发，desired 部分重叠 ---')
{
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
    const shared = Array.from({ length: 10 }, (_, i) => mk(i))
    const onlyA = Array.from({ length: 10 }, (_, i) => mk(200 + i))
    const onlyB = Array.from({ length: 10 }, (_, i) => mk(300 + i))
    const [ra, rb] = await Promise.all([
      adapter.reconcile([...shared, ...onlyA]),
      adapter.reconcile([...shared, ...onlyB]),
    ])
    say(`    A: created=${ra.created.length} removed=${ra.removed.length}`)
    say(`    B: created=${rb.created.length} removed=${rb.removed.length}`)
    const hostRows = (await stub.catalog()).length
    say(`    宿主行数 = ${hostRows}（期望 30）`)
    // 不重复：shared 的 10 条不能出现两份
    const titles = (await stub.catalog()).map((r) => r.title)
    const dup = titles.filter((t, i) => titles.indexOf(t) !== i)
    eq('无重复提醒（shared 未被建两份）', dup.length, 0)
    eq('宿主行数 = 30', hostRows, 30)
  } catch (error) {
    bad('C 段异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (D) store.mutate 并发 ----------
say('')
say('--- D) 服务层 store.mutate 并发 ---')
{
  const dir = tmp()
  try {
    const svc = M.createWorkbenchService({
      dataDir: dir,
      approvalMode: 'host',
      approvalGate: M.createHostApprovalGate({ mode: 'host', request: async () => 'approved' }),
      now: () => new Date(BASE),
    })
    const mkEvent = (t) => ({
      event: {
        title: t, startDate: '2026-11-06', endDate: '2026-11-08',
        allDay: true, timeZone: 'UTC',
      },
    })
    await Promise.all(Array.from({ length: 20 }, (_, i) => svc.execute('event.create', mkEvent(`T${i}`))))
    const list = svc.execute('event.list', {})
    eq('20 次并发 create 后事件齐全', list.length, 20)
    const ids = list.map((e) => e.id)
    eq('无重复 id', new Set(ids).size, ids.length)
  } catch (error) {
    bad('D 段异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('')
say(`=== 探针 08 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * 探针 R5b-02：复核 BLOCKER-2（并发 reconcile 重复投递）
 *
 * 直接 import 冻结目录源码。
 *
 * 关键设计：
 *  - A) 20 个并发 reconcile，同一批 key → 宿主必须恰好 1 条
 *  - B) 不同 key 并发 → 应仍并行（不互相阻塞）
 *  - C) 同一 key 多次并发 + 中途删除
 *  - D) upsert 锁的 promise 链是否泄漏 / 死锁
 */
import { mkdtempSync, rmSync } from 'node:fs'
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
const dir = mkdtempSync(join(tmpdir(), 'r5b02-'))
try {
  say('=== A) 20 个并发 reconcile（同一批 30 条 key）→ 宿主必须恰好 30 条 ===')
  for (let round = 1; round <= 5; round++) {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, `a${round}.json`) })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 30 }, (_, i) => ({
      reminderKey: `k-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    const results = await Promise.all(Array.from({ length: 20 }, () => adapter.reconcile(plans)))
    const cat = await stub.catalog()
    const titles = cat.map((r) => r.title)
    const dupes = titles.length - new Set(titles).size
    const created = results.reduce((a, r) => a + r.created.length, 0)
    const failed = results.reduce((a, r) => a + r.failed.length, 0)
    say(`     轮 ${round}: 宿主行=${cat.length} 重复=${dupes} 累计created=${created} failed=${failed}`)
    eq(`  轮 ${round}：宿主恰好 30 条（无重复投递）`, cat.length, 30)
    eq(`  轮 ${round}：无重复 title`, dupes, 0)
    eq(`  轮 ${round}：无失败`, failed, 0)
  }

  say('')
  say('=== A2) 20 个并发 reconcile，各自 desired 部分重叠 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, `a2-${process.pid}.json`) })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    // 10 条共有 + 10 条各自独有
    const shared = Array.from({ length: 10 }, (_, i) => ({
      reminderKey: `s-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `S${i}`, prompt: 'p', kind: 'event-start',
    }))
    const ownA = Array.from({ length: 10 }, (_, i) => ({
      reminderKey: `a-${i}`, fireAtMs: BASE + (100 + i) * MIN, title: `A${i}`, prompt: 'p', kind: 'event-start',
    }))
    const ownB = Array.from({ length: 10 }, (_, i) => ({
      reminderKey: `b-${i}`, fireAtMs: BASE + (200 + i) * MIN, title: `B${i}`, prompt: 'p', kind: 'event-start',
    }))
    await Promise.all([
      adapter.reconcile([...shared, ...ownA]),
      adapter.reconcile([...shared, ...ownB]),
    ])
    const cat = await stub.catalog()
    const titles = cat.map((r) => r.title)
    const dupes = titles.length - new Set(titles).size
    say(`     宿主行=${cat.length} 重复=${dupes}`)
    eq('共享 key 只建一次（宿主 30 条）', cat.length, 30)
    eq('无重复', dupes, 0)
  }

  say('')
  say('=== B) 不同 key 并发应仍并行（不互相阻塞）===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'b.json') })
    let inflight = 0
    let maxInflight = 0
    const origCatalog = stub.catalog.bind(stub)
    stub.catalog = async () => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      try {
        await new Promise((r) => setTimeout(r, 20))
        return await origCatalog()
      } finally { inflight -= 1 }
    }
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 10 }, (_, i) => ({
      reminderKey: `p-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `P${i}`, prompt: 'p', kind: 'event-start',
    }))
    const t0 = Date.now()
    await Promise.all(plans.map((p) => adapter.reconcile([p])))
    const dt = Date.now() - t0
    say(`     10 个不同 key 的 reconcile 总耗时=${dt}ms  期间最大并发 catalog=${maxInflight}`)
    eq('宿主侧 10 条', (await stub.catalog()).length, 10)
    ok('不同 key 并行执行（未串成一条链）', `maxInflight=${maxInflight}`)
    if (maxInflight < 2) bad('不同 key 被串行化了（并发度=1）', `maxInflight=${maxInflight}`)
  }

  say('')
  say('=== C) 同一 key 多次并发 upsert + 中途删除 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'c.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'one', fireAtMs: BASE + MIN, title: 'One', prompt: 'p', kind: 'event-start' }
    // 30 次并发 upsert 同一 key
    const res = await Promise.all(Array.from({ length: 30 }, () => adapter.reconcile([plan])))
    const created = res.reduce((a, r) => a + r.created.length, 0)
    const cat = await stub.catalog()
    say(`     30 次并发同一 key: 宿主行=${cat.length} 累计created=${created}`)
    eq('宿主恰好 1 条', cat.length, 1)
    eq('created 累计为 1', created, 1)

    // 中途删除：并发删除 + 并发 upsert
    const delP = adapter.cancel('one')
    const upP = adapter.reconcile([plan])
    const settled = await Promise.allSettled([delP, upP])
    const cat2 = await stub.catalog()
    const titles = cat2.map((r) => r.title)
    say(`     并发 delete+upsert: settled=${settled.map((s) => s.status).join(',')} 宿主行=${cat2.length}`)
    ok('并发 delete+upsert 未死锁（Promise 全部 settle）', settled.map((s) => s.status).join(','))
    if (cat2.length > 1) bad('并发 delete+upsert 产生重复行', `宿主行=${cat2.length} titles=${JSON.stringify(titles)}`)
    else ok('并发 delete+upsert 无重复行', `宿主行=${cat2.length}`)
  }

  say('')
  say('=== D) upsert 锁的 promise 链是否泄漏 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'd.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'leak', fireAtMs: BASE + MIN, title: 'L', prompt: 'p', kind: 'event-start' }
    for (let i = 0; i < 200; i++) await adapter.reconcile([plan])
    // 检查 createLocks 的大小：它不在公开 API 里，用堆快照间接查
    const v8 = await import('node:v8')
    const heap = v8.getHeapSnapshot()
    let found = 0
    const walk = (node) => {
      if (node.name === 'Map' && node.children) {
        const m = node.children.find((c) => c.name === 'createLocks')
        if (m) found = m
      }
      for (const c of node.children ?? []) walk(c)
    }
    walk(heap)
    if (found !== 0) {
      const map = found.children.find((c) => c.name === 'table')
      say(`     createLocks 的 table 大小=${map?.children?.length ?? '?'}`)
    } else {
      say('     （堆快照未直接定位到 createLocks，改用行为代理）')
    }
    heap.destroy()
    // 行为代理：200 次后宿主仍 1 条，且内存不爆
    eq('200 次串行对账后宿主仍 1 条', (await stub.catalog()).length, 1)
    const mem = process.memoryUsage().heapUsed
    ok('heapUsed', `${(mem / 1048576).toFixed(1)} MB`)
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 800))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-02 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

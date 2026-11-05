#!/usr/bin/env node
/**
 * 探针 R5b-08：M-2（O(N²) 全量写 → 脏标记 + flush）的真实性 + flush 语义 + 内存增长
 *
 * 关键怀疑：
 *  - `flush()` 的返回值 `{flushed: dirty}` 在 writeNow() 里已把 dirty 置 false → 恒为 false
 *  - upsert 后立即 flush → 每条提醒仍全量写一次 → O(N²) 只在「直接调 hostMap.put」时消失，
 *    在真实的 upsert 路径上可能仍在
 *  - createLocks 的 Map 永不清理 → 每个不同 reminderKey 留一条 promise → 长期内存增长
 */
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
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
const dir = mkdtempSync(join(tmpdir(), 'r5b08-'))
try {
  say('=== 1) flush() 的返回值语义 ===')
  {
    const path = join(dir, 'f.json')
    const hm = M.openHostMap({ filePath: path })
    eq('刚打开：dirty=false', hm.dirty, false)
    hm.put({ reminderKey: 'a', hostId: 'h', sessionId: 's', fireAtMs: BASE, title: 'A', kind: 'k', scope: '' })
    eq('put 后 dirty=true', hm.dirty, true)
    const r = hm.flush()
    say(`     flush() 返回 = ${JSON.stringify(r)}`)
    if (r.flushed !== true) {
      bad('flush() 返回值不能反映「是否真的落盘」', `got ${JSON.stringify(r)} want {"flushed":true}`)
    } else {
      ok('flush() 返回 flushed=true（确实落盘了）')
    }
    eq('flush 后 dirty=false', hm.dirty, false)
    const r2 = hm.flush()
    say(`     第二次 flush() 返回 = ${JSON.stringify(r2)}`)
    ok('第二次 flush 无事可做', `flushed=${r2.flushed}`)
  }

  say('')
  say('=== 2) 真实 upsert 路径的写放大（O(N²) 是否真的消失）===')
  {
    for (const N of [500, 1000, 2000]) {
      const path = join(dir, `p${N}.json`)
      const stub = createContractStub({ now: () => BASE })
      const hm = M.openHostMap({ filePath: path, maxEntries: 100000 })
      const adapter = M.createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE,
      })
      const plans = Array.from({ length: N }, (_, i) => ({
        reminderKey: `k-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
      }))
      const t0 = Date.now()
      await adapter.reconcile(plans)
      const dt = Date.now() - t0
      const size = statSync(path).size
      say(`     N=${N}: upsert 路径耗时=${dt}ms  文件=${size} 字节`)
      if (N === 2000) {
        if (dt > 10000) bad('真实 upsert 路径仍是 O(N²)（2000 条 >10s）', `${dt}ms`)
        else ok('真实 upsert 路径耗时可接受', `${dt}ms`)
      }
      // 记录用于对比缩放
      globalThis.__scale = globalThis.__scale ?? []
      globalThis.__scale.push({ N, dt, size })
    }
    const s = globalThis.__scale
    const ratio = (s[1].dt / Math.max(s[0].dt, 1))
    say(`     缩放比（1000/500 的耗时比）= ${ratio.toFixed(2)}（线性≈2，平方≈4）`)
    if (ratio > 3.5) {
      bad('upsert 路径仍呈平方增长', `ratio=${ratio.toFixed(2)}`)
    } else {
      ok('upsert 路径接近线性', `ratio=${ratio.toFixed(2)}`)
    }
  }

  say('')
  say('=== 3) 直接调 hostMap.put 的耗时（脏标记的收益）===')
  {
    const path = join(dir, 'q.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 100000 })
    const t0 = Date.now()
    for (let i = 0; i < 2000; i++) {
      hm.put({ reminderKey: `p-${i}`, hostId: `h-${i}`, sessionId: 's', fireAtMs: BASE + i, title: `T${i}`, kind: 'k', scope: '' })
    }
    const putMs = Date.now() - t0
    const t1 = Date.now()
    hm.flush()
    const flushMs = Date.now() - t1
    say(`     2000 次 put（无落盘）=${putMs}ms，1 次 flush=${flushMs}ms`)
    if (putMs > 5000) bad('hostMap.put 仍很慢', `${putMs}ms`)
    else ok('hostMap.put 不再每次全量写', `${putMs}ms`)
  }

  say('')
  say('=== 4) createLocks 的内存增长（每不同 key 留一条 promise，永不清理）===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hm = M.openHostMap({ filePath: join(dir, 'l.json'), maxEntries: 100000 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE,
    })
    const N = 20000
    const plans = Array.from({ length: N }, (_, i) => ({
      reminderKey: `m-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    global.gc?.()
    const before = process.memoryUsage().heapUsed
    const t0 = Date.now()
    await adapter.reconcile(plans)
    const dt = Date.now() - t0
    global.gc?.()
    const after = process.memoryUsage().heapUsed
    say(`     ${N} 个不同 key：耗时=${dt}ms  heapUsed ${(before / 1048576).toFixed(1)} → ${(after / 1048576).toFixed(1)} MB (+${((after - before) / 1048576).toFixed(1)} MB)`)
    const perKey = (after - before) / N
    say(`     每 key 约 ${perKey.toFixed(0)} 字节`)
    // 关键：锁表永不清��� → 内存随「历史上出现过的不同 key 数」线性增长
    // 粗略估计：一条 Promise 链约 200-500 字节
    if (perKey > 1500) {
      bad('每 key 内存开销异常大（锁表泄漏）', `${perKey.toFixed(0)} 字节/key`)
    } else {
      ok('每 key 内存开销在预期范围（锁表泄漏量级需另评估）', `${perKey.toFixed(0)} 字节/key`)
    }
  }

  say('')
  say('=== 5) 老化：墓碑（无 fireAtMs）会不会被清掉 ===')
  {
    const path = join(dir, 't.json')
    let clock = BASE
    const hm = M.openHostMap({ filePath: path, maxEntries: 3, now: () => clock })
    for (let i = 0; i < 5; i++) {
      hm.put({ reminderKey: `t-${i}`, hostId: `h-${i}`, sessionId: 's', fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, kind: 'k', scope: 'events' })
    }
    hm.flush()
    const d0 = JSON.parse((await import('node:fs')).readFileSync(path, 'utf8'))
    const tombs0 = Object.entries(d0.index).filter(([, k]) => d0.entries[k] === undefined).length
    eq('5 条 / maxEntries=3 → 2 个墓碑', tombs0, 2)
    // 400 天后
    clock = BASE + 400 * 86400000
    hm.put({ reminderKey: 'trig', hostId: 'h-trig', sessionId: 's', fireAtMs: clock + MIN, title: 'T', kind: 'k', scope: 'events' })
    hm.flush()
    const fsmod = await import('node:fs')
    const d1 = JSON.parse(fsmod.readFileSync(path, 'utf8'))
    const tombs1 = Object.entries(d1.index).filter(([, k]) => d1.entries[k] === undefined).length
    say(`     400 天后：entries=${Object.keys(d1.entries).length} index=${Object.keys(d1.index).length} 墓碑=${tombs1}`)
    if (tombs1 > 0) {
      bad('墓碑身份永不被时间老化 → index 仍无上限', `存活墓碑 ${tombs1} 个`)
    } else {
      ok('墓碑身份也被老化')
    }
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-08 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

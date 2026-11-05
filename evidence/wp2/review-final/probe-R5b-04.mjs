#!/usr/bin/env node
/**
 * 探针 R5b-04：M-1（index 无上限 → 声称改为按时间老化 180 天）的独立复核
 *
 * 关键怀疑：prune() 的老化循环用 `state.entries[key]?.fireAtMs` 判龄；
 * 而被条数裁剪掉���条目（墓碑）已不在 entries 里 → fireAtMs 为 undefined
 * → `continue`（保守保留）→ **墓碑永远不会被老化** → index 仍无上限。
 */
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
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
const DAY = 86_400_000
const dir = mkdtempSync(join(tmpdir(), 'r5b04-'))
try {
  say('=== A) 体积与 index 增长曲线（每轮 1000 条，累计）===')
  {
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const mapPath = join(dir, 'grow.json')
    const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => clock,
    })
    let n = 0
    for (let round = 1; round <= 5; round++) {
      const plans = Array.from({ length: 1000 }, (_, i) => ({
        reminderKey: `g-${n + i}`, fireAtMs: clock + (i + 1) * MIN, title: `T${n + i}`, prompt: 'p', kind: 'event-start',
      }))
      n += 1000
      await adapter.reconcile(plans)
      const disk = JSON.parse(readFileSync(mapPath, 'utf8'))
      const size = statSync(mapPath).size
      say(`     累计创建 ${n} → entries=${Object.keys(disk.entries).length} index=${Object.keys(disk.index).length} 文件=${size} 字节`)
    }
    const disk = JSON.parse(readFileSync(mapPath, 'utf8'))
    const indexCount = Object.keys(disk.index).length
    const size = statSync(mapPath).size
    // 每条 index 身份的字节数
    const perEntry = size / indexCount
    say(`     每条身份约 ${perEntry.toFixed(1)} 字节`)
    ok('index 体积', `${indexCount} 项 / ${size} 字节`)
  }

  say('')
  say('=== B) 关键：墓碑（被条数裁剪的条目）会不会被时间老化？ ===')
  {
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const hostMap = M.openHostMap({ filePath: join(dir, 'tomb.json'), maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => clock,
    })
    // 建立 600 条 → 100 条变墓碑
    const plans = Array.from({ length: 600 }, (_, i) => ({
      reminderKey: `t-${i}`, fireAtMs: clock + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    eq('entries 裁到 500', hostMap.size, 500)
    eq('t-0 是墓碑', hostMap.get('t-0'), undefined)
    // 时间跳 400 天后（远超 180 天保留窗口）
    clock = BASE + 400 * DAY
    // 触发一次老化（put 会调 prune）
    hostMap.put({ reminderKey: 'trigger', hostId: 'trigger-host', sessionId: 's1', fireAtMs: clock + MIN, title: 'Trig', kind: 'event-start', scope: '' })
    const disk = JSON.parse(readFileSync(join(dir, 'tomb.json'), 'utf8'))
    const indexCount = Object.keys(disk.index).length
    const entriesCount = Object.keys(disk.entries).length
    say(`     400 天后：entries=${entriesCount} index=${indexCount}`)
    // 完整条目里 fireAtMs 都很旧（BASE+1min ~ BASE+600min）→ 应被老化掉
    if (entriesCount > 2) {
      bad('时间老化未清掉过期完整条目', `entries=${entriesCount}（应只剩 1 条 trigger）`)
    } else {
      ok('时间老化清掉了过期完整条目', `entries=${entriesCount}`)
    }
    // 墓碑（100 条 t-*）呢？
    const tombAlive = ['t-0', 't-1', 't-99'].filter((k) => disk.index && Object.values(disk.index).includes(k))
    say(`     400 天后仍存活的墓碑身份: ${JSON.stringify(tombAlive)}`)
    if (tombAlive.length > 0) {
      bad('墓碑身份永远不被时间老化 → index 仍无上限', `存活墓碑 ${tombAlive.length}/3：${JSON.stringify(tombAlive)}`)
    } else {
      ok('墓碑身份也被老化掉')
    }
  }

  say('')
  say('=== C) 长时间运行：index 是否收敛 ===')
  {
    // 模拟长期运行：每轮创建 1000 条旧提醒（触发时刻在过去），时间逐步前进
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const mapPath = join(dir, 'conv.json')
    const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => clock,
    })
    let n = 0
    for (let round = 1; round <= 4; round++) {
      clock = BASE + round * 30 * DAY
      const plans = Array.from({ length: 1000 }, (_, i) => ({
        reminderKey: `c-${n + i}`, fireAtMs: clock - 200 * DAY + (i + 1) * MIN, title: `T${n + i}`, prompt: 'p', kind: 'event-start',
      }))
      n += 1000
      await adapter.reconcile(plans)
      const disk = JSON.parse(readFileSync(mapPath, 'utf8'))
      say(`     轮 ${round}（累计 ${n}）→ entries=${Object.keys(disk.entries).length} index=${Object.keys(disk.index).length} 文件=${statSync(mapPath).size} 字节`)
    }
    const disk = JSON.parse(readFileSync(mapPath, 'utf8'))
    const indexCount = Object.keys(disk.index).length
    if (indexCount > 1500) {
      bad('index 未收敛（4000 条创建后仍 >1500 项）', `index=${indexCount}`)
    } else {
      ok('index 收敛', `index=${indexCount}`)
    }
  }

  say('')
  say('=== D) M-2：hostMap.put 是否仍是 O(N²) 全量写 ===')
  {
    const mapPath = join(dir, 'perf.json')
    const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 100000 })
    const t0 = Date.now()
    for (let i = 0; i < 2000; i++) {
      hostMap.put({ reminderKey: `p-${i}`, hostId: `h-${i}`, sessionId: 's', fireAtMs: BASE + i, title: `T${i}`, kind: 'k', scope: '' })
    }
    const putMs = Date.now() - t0
    const t1 = Date.now()
    hostMap.flush()
    const flushMs = Date.now() - t1
    say(`     2000 次 put（不落盘）= ${putMs}ms；1 次 flush = ${flushMs}ms`)
    ok('put 不再每次全量写', `put ${putMs}ms / flush ${flushMs}ms`)
    if (putMs > 5000) bad('put 仍是 O(N²)', `${putMs}ms`)
  }

  say('')
  say('=== E) M-2 真实性：flush 语义下 upsert 是否每次都全量写？ ===')
  {
    const mapPath = join(dir, 'perf2.json')
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 100000 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 2000 }, (_, i) => ({
      reminderKey: `x-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    const t0 = Date.now()
    await adapter.reconcile(plans)
    const dt = Date.now() - t0
    say(`     2000 条 upsert（每条都 flush）= ${dt}ms`)
    ok('upsert 路径耗时', `${dt}ms`)
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-04 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * 探针 R5b-05：时间老化（180 天）的精确行为
 *
 * 上一探针的观测与源码读数不一致，需精确定位：
 *   - 老化循环遍历的是 `state.index`（hostId → reminderKey），
 *     用 `state.entries[key]?.fireAtMs` 判龄；
 *   - 若某条**完整条目**不在 index 里，它就永远不被老化。
 *   - 墓碑的 fireAtMs 为 undefined → `continue` → 墓碑永不被老化。
 */
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5b-freeze-368207b'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)

let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000
const DAY = 86_400_000
const dir = mkdtempSync(join(tmpdir(), 'r5b05-'))
try {
  say('=== A) 直接单测 openHostMap 的老化行为 ===')
  {
    let clock = BASE
    const path = join(dir, 'a.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 1000, now: () => clock })
    hm.put({ reminderKey: 'old1', hostId: 'h-old1', sessionId: 's', fireAtMs: BASE - 300 * DAY, title: 'O1', kind: 'k', scope: 'events' })
    hm.put({ reminderKey: 'old2', hostId: 'h-old2', sessionId: 's', fireAtMs: BASE - 300 * DAY, title: 'O2', kind: 'k', scope: 'events' })
    hm.put({ reminderKey: 'new1', hostId: 'h-new1', sessionId: 's', fireAtMs: BASE + 10 * DAY, title: 'N1', kind: 'k', scope: 'events' })
    hm.flush()
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    say(`     刚写入：entries=${Object.keys(disk.entries).length} index=${Object.keys(disk.index).length}`)
    eq('三条都在 entries', Object.keys(disk.entries).length, 3)

    // 时间跳 400 天后，触发一次 put → prune
    clock = BASE + 400 * DAY
    hm.put({ reminderKey: 'trigger', hostId: 'h-trig', sessionId: 's', fireAtMs: clock + MIN, title: 'Trig', kind: 'k', scope: 'events' })
    hm.flush()
    const disk2 = JSON.parse(readFileSync(path, 'utf8'))
    say(`     400 天后：entries=${Object.keys(disk2.entries).length} index=${Object.keys(disk2.index).length}`)
    say(`     存活 entries: ${JSON.stringify(Object.keys(disk2.entries))}`)
    say(`     存活 index:   ${JSON.stringify(Object.entries(disk2.index).map(([h, k]) => h + '->' + k))}`)
    const alive = Object.keys(disk2.entries)
    if (alive.includes('old1') || alive.includes('old2')) {
      bad('过期（300 天前）提醒的身份未被老化', `存活=${JSON.stringify(alive)}`)
    } else {
      ok('过期提醒的身份被老化掉', `存活=${JSON.stringify(alive)}`)
    }
    if (!alive.includes('new1')) {
      bad('近期提醒的身份被误删', `存活=${JSON.stringify(alive)}`)
    } else {
      ok('近期提醒的身份保留')
    }
  }

  say('')
  say('=== B) 墓碑（无 fireAtMs）会不会被老化 ===')
  {
    let clock = BASE
    const path = join(dir, 'b.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 3, now: () => clock })
    // 5 条 → 2 条成墓碑
    for (let i = 0; i < 5; i++) {
      hm.put({ reminderKey: `t-${i}`, hostId: `h-${i}`, sessionId: 's', fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, kind: 'k', scope: 'events' })
    }
    hm.flush()
    const d0 = JSON.parse(readFileSync(path, 'utf8'))
    say(`     5 条后：entries=${Object.keys(d0.entries).length} index=${Object.keys(d0.index).length}`)
    const tombs = Object.entries(d0.index).filter(([, k]) => d0.entries[k] === undefined).map(([h, k]) => h + '->' + k)
    say(`     墓碑: ${JSON.stringify(tombs)}`)
    eq('有 2 个墓碑', tombs.length, 2)

    clock = BASE + 400 * DAY
    hm.put({ reminderKey: 'trigger', hostId: 'h-trig', sessionId: 's', fireAtMs: clock + MIN, title: 'Trig', kind: 'k', scope: 'events' })
    hm.flush()
    const d1 = JSON.parse(readFileSync(path, 'utf8'))
    const aliveTombs = Object.entries(d1.index).filter(([, k]) => d1.entries[k] === undefined).map(([h, k]) => h + '->' + k)
    say(`     400 天后：entries=${Object.keys(d1.entries).length} index=${Object.keys(d1.index).length} 存活墓碑=${JSON.stringify(aliveTombs)}`)
    if (aliveTombs.length > 0) {
      bad('墓碑身份永不被时间老化（index 仍无上限）', `存活墓碑 ${aliveTombs.length} 个：${JSON.stringify(aliveTombs)}`)
    } else {
      ok('墓碑身份也被老化')
    }
  }

  say('')
  say('=== C) index 体积：只算身份索引（每条多少字节）===')
  {
    const path = join(dir, 'c.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 500 })
    for (let i = 0; i < 5000; i++) {
      hm.put({ reminderKey: `k${i}`, hostId: `schedule-${i}`, sessionId: 's', fireAtMs: BASE + i, title: `T${i}`, kind: 'event-start', scope: 'events' })
    }
    hm.flush()
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const size = statSync(path).size
    const idx = Object.keys(d.index).length
    // 估算 index 自身体积：把 entries 清空后重写一遍
    const idxOnly = JSON.stringify(d.index).length
    say(`     5000 条后：entries=${Object.keys(d.entries).length} index=${idx} 文件=${size} 字节`)
    say(`     index 自身 JSON 体积 = ${idxOnly} 字节 → 每条 ${(idxOnly / idx).toFixed(1)} 字节`)
    ok('每条身份字节数', `${(idxOnly / idx).toFixed(1)} B/条（声称 ~27）`)
  }

  say('')
  say('=== D) 长期运行：desired 单调增长时 index 是否收敛 ===')
  {
    const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const path = join(dir, 'd.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => clock })
    let n = 0
    for (let round = 1; round <= 4; round++) {
      // 每轮新建 500 条（desired 单调增长，不删旧的）
      const plans = Array.from({ length: 500 }, (_, i) => ({
        reminderKey: `d-${n + i}`, fireAtMs: clock + (n + i + 1) * MIN, title: `T${n + i}`, prompt: 'p', kind: 'event-start',
      }))
      n += 500
      const r = await adapter.reconcile(plans)
      const d = JSON.parse(readFileSync(path, 'utf8'))
      say(`     轮 ${round}（累计 ${n}）：created=${r.created.length} failed=${r.failed.length} entries=${Object.keys(d.entries).length} index=${Object.keys(d.index).length} 文件=${statSync(path).size} 字节`)
    }
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const idx = Object.keys(d.index).length
    if (idx > 2000) {
      bad('desired 单调增长时 index 不收敛', `index=${idx}`)
    } else {
      ok('index 在合理范围', `index=${idx}`)
    }
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-05 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

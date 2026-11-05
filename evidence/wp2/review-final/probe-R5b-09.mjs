#!/usr/bin/env node
/**
 * 探针 R5b-09：精确定位 prune() 的三条分支
 *
 * 源码（host-map.js prune）：
 *   1) 时间老化：遍历 state.index，用 state.entries[key]?.fireAtMs 判龄；
 *      fireAtMs === undefined → continue（保守保留）
 *   2) 条数裁剪：entries.length > maxEntries → 把最旧的移出 entries，身份留 index
 *
 * 关键问题：
 *  - 分支 1 只能老化**仍在 entries 里**的条目；
 *  - 分支 2 制造**墓碑**（entries 里没有、index 里有），而墓碑没有 fireAtMs
 *    → 分支 1 永远跳过它 → **墓碑永不过期**
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
const dir = mkdtempSync(join(tmpdir(), 'r5b09-'))
try {
  say('=== A) 单一分支隔离：只跑条数裁剪，看 index 怎么长 ===')
  {
    const path = join(dir, 'a.json')
    let clock = BASE
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    // 1000 条，全部 fireAtMs 在同一小时内（不触发老化）
    for (let i = 0; i < 1000; i++) {
      hm.put({ reminderKey: `k${i}`, hostId: `h${i}`, sessionId: 's', fireAtMs: BASE + i, title: `T${i}`, kind: 'k', scope: 'events' })
    }
    hm.flush()
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const tombs = Object.entries(d.index).filter(([, k]) => d.entries[k] === undefined)
    say(`     1000 条 / maxEntries=500 → entries=${Object.keys(d.entries).length} index=${Object.keys(d.index).length} 墓碑=${tombs.length}`)
    eq('entries=500', Object.keys(d.entries).length, 500)
    eq('index=1000（身份全留）', Object.keys(d.index).length, 1000)
    eq('墓碑=500', tombs.length, 500)
  }

  say('')
  say('=== B) 时间老化分支：能不能清掉墓碑？ ===')
  {
    const path = join(dir, 'b.json')
    let clock = BASE
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    for (let i = 0; i < 1000; i++) {
      hm.put({ reminderKey: `k${i}`, hostId: `h${i}`, sessionId: 's', fireAtMs: BASE + i, title: `T${i}`, kind: 'k', scope: 'events' })
    }
    hm.flush()
    // 时间跳到 400 天后
    clock = BASE + 400 * DAY
    hm.put({ reminderKey: 'trig', hostId: 'htrig', sessionId: 's', fireAtMs: clock + MIN, title: 'T', kind: 'k', scope: 'events' })
    hm.flush()
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const tombs = Object.entries(d.index).filter(([, k]) => d.entries[k] === undefined)
    const aliveEntries = Object.keys(d.entries)
    say(`     400 天后 → entries=${aliveEntries.length} index=${Object.keys(d.index).length} 墓碑=${tombs.length}`)
    eq('完整条目全被老化掉（只剩 trig）', aliveEntries.length, 1)
    if (tombs.length > 0) {
      bad('墓碑身份永不被时间老化', `存活墓碑 ${tombs.length} 个 / index ${Object.keys(d.index).length} 项`)
    } else {
      ok('墓碑也被老化')
    }
  }

  say('')
  say('=== C) 墓碑不老化 → index 无上限（长期运行）===')
  {
    const path = join(dir, 'c.json')
    let clock = BASE
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    // 模拟真实长期运行：每一轮创建 600 条（触发 100 个新墓碑），时间前进 1 天
    for (let round = 1; round <= 5; round++) {
      clock = BASE + (round - 1) * DAY
      for (let i = 0; i < 600; i++) {
        const n = (round - 1) * 600 + i
        hm.put({
          reminderKey: `k${n}`, hostId: `h${n}`, sessionId: 's',
          fireAtMs: clock + (i + 1) * MIN, title: `T${n}`, kind: 'k', scope: 'events',
        })
      }
      hm.flush()
      const d = JSON.parse(readFileSync(path, 'utf8'))
      const tombs = Object.values(d.index).filter((k) => d.entries[k] === undefined).length
      say(`     轮 ${round}（累计 ${round * 600} 条）→ entries=${Object.keys(d.entries).length} index=${Object.keys(d.index).length} 墓碑=${tombs} 文件=${statSync(path).size} 字节`)
    }
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const idx = Object.keys(d.index).length
    if (idx > 600) {
      bad('长期运行 index 无上限（墓碑永不过期）', `index=${idx}（累计创建 3000 条）`)
    } else {
      ok('index 收敛', `index=${idx}`)
    }
  }

  say('')
  say('=== D) 墓碑不过期 → 宿主侧已删的行会变成 unmapped？ ===')
  {
    const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const path = join(dir, 'd.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => clock,
    })
    const plans = Array.from({ length: 600 }, (_, i) => ({
      reminderKey: `k${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    eq('宿主 600 条', (await stub.catalog()).length, 600)
    eq('entries=500', hm.size, 500)
    eq('无 unmapped', (await adapter.catalog()).unmapped.length, 0)
    // 400 天后：完整条目被老化 → 墓碑保留 → 但**所有**身份都失去 fireAtMs 或被删
    clock = BASE + 400 * DAY
    hm.put({ reminderKey: 'trig', hostId: 'htrig', sessionId: 's1', fireAtMs: clock + MIN, title: 'T', prompt: 'p', kind: 'event-start', scope: '' })
    const cat = await adapter.catalog()
    say(`     400 天后 catalog: rows=${cat.rows.length} unmapped=${cat.unmapped.length} needsAttention=${cat.needsAttention}`)
    ok('观测', `unmapped=${cat.unmapped.length}`)
  }

  say('')
  say('=== E) 对比：上一轮实现（2b0aabb，index 无上限）的行为 ===')
  {
    // 用 git archive 导出上一轮基准
    const { execFileSync } = await import('node:child_process')
    const prev = '/tmp/wp2r5b-prev'
    execFileSync('bash', ['-lc', `rm -rf ${prev} && mkdir -p ${prev} && cd /Users/sylas/Developer/dsh-workbench && git archive 2b0aabb | tar -x -C ${prev}`])
    const P = await import(`${prev}/workbench-core/src/index.js`)
    let clock = BASE
    const hm = P.openHostMap({ filePath: join(dir, 'e.json'), maxEntries: 500, now: () => clock })
    for (let i = 0; i < 1000; i++) {
      hm.put({ reminderKey: `k${i}`, hostId: `h${i}`, sessionId: 's', fireAtMs: BASE + i, title: `T${i}`, kind: 'k', scope: 'events' })
    }
    hm.flush()
    const d = JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8'))
    say(`     2b0aabb: 1000 条 / maxEntries=500 → entries=${Object.keys(d.entries).length} index=${Object.keys(d.index).length}`)
    ok('对照', `index=${Object.keys(d.index).length}`)
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-09 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

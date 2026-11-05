#!/usr/bin/env node
/**
 * 探针 R5b-10：M-1 的真实有效性 —— 长期运行时 index 是否收敛
 *
 * 关键区别：
 *  - 完整条目（有 fireAtMs）→ 会被时间老化清掉
 *  - 墓碑（被条数裁剪，entries 里没有）→ fireAtMs undefined → **永不老化**
 *
 * 本探针模拟「用户每天都有新提醒、老的陆续过期」的真实长期运行。
 */
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
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
const dir = mkdtempSync(join(tmpdir(), 'r5b10-'))
try {
  say('=== A) 真实长期运行：每天 20 条新提醒，跑 12 个月 ===')
  {
    let clock = BASE
    const path = join(dir, 'a.json')
    const stub = createContractStub({ now: () => clock })
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => clock,
    })
    let n = 0
    for (let day = 0; day < 360; day++) {
      clock = BASE + day * DAY
      const plans = Array.from({ length: 20 }, (_, i) => ({
        reminderKey: `k${n + i}`, fireAtMs: clock + (i + 1) * MIN, title: `T${n + i}`, prompt: 'p', kind: 'event-start',
      }))
      n += 20
      await adapter.reconcile(plans)
      // 删掉过期的（模拟事件被清理）
      await adapter.reconcile([])
      if ((day + 1) % 60 === 0) {
        const d = JSON.parse(readFileSync(path, 'utf8'))
        const tombs = Object.values(d.index).filter((k) => d.entries[k] === undefined).length
        say(`     第 ${day + 1} 天（累计 ${n} 条）→ entries=${Object.keys(d.entries).length} index=${Object.keys(d.index).length} 墓碑=${tombs} 文件=${statSync(path).size} 字节`)
      }
    }
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const idx = Object.keys(d.index).length
    const tombs = Object.values(d.index).filter((k) => d.entries[k] === undefined).length
    say(`     最终：index=${idx} 墓碑=${tombs} 文件=${statSync(path).size} 字节`)
    if (idx > 1000) {
      bad('长期运行 index 不收敛（墓碑永不过期）', `index=${idx}，其中墓碑 ${tombs} 个`)
    } else {
      ok('index 收敛', `index=${idx}`)
    }
  }

  say('')
  say('=== B) 墓碑不过期的直接后果：index 体积随「累计创建量」单调增长 ===')
  {
    const path = join(dir, 'b.json')
    let clock = BASE
    const hm = M.openHostMap({ filePath: path, maxEntries: 500, now: () => clock })
    for (let round = 1; round <= 6; round++) {
      // 每轮 600 条，全部在未来 1 天内（近期）→ 不会老化；超出 500 的成墓碑
      clock = BASE + (round - 1) * DAY
      for (let i = 0; i < 600; i++) {
        const n2 = (round - 1) * 600 + i
        hm.put({ reminderKey: `k${n2}`, hostId: `h${n2}`, sessionId: 's', fireAtMs: clock + (i + 1) * MIN, title: `T${n2}`, kind: 'k', scope: 'events' })
      }
      hm.flush()
      const d = JSON.parse(readFileSync(path, 'utf8'))
      const tombs = Object.values(d.index).filter((k) => d.entries[k] === undefined).length
      say(`     轮 ${round}（累计 ${round * 600}）→ entries=${Object.keys(d.entries).length} index=${Object.keys(d.index).length} 墓碑=${tombs} 文件=${statSync(path).size} 字节`)
    }
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const idx = Object.keys(d.index).length
    if (idx > 1200) bad('index 随累计创建量单调增长', `index=${idx}（累计 3600）`)
    else ok('index 有界', `index=${idx}`)
  }

  say('')
  say('=== C) 墓碑不过期 → 宿主侧已删除的行是否被误当成「多余项」删除？ ===')
  {
    let clock = BASE
    const stub = createContractStub({ now: () => BASE })
    const hm = M.openHostMap({ filePath: join(dir, 'c.json'), maxEntries: 500, now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => clock,
    })
    const plans = Array.from({ length: 600 }, (_, i) => ({
      reminderKey: `k${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    eq('宿主 600 条', (await stub.catalog()).length, 600)
    // 墓碑行仍在 index → catalog 能认领 → 不会被误删
    const cat = await adapter.catalog()
    eq('600 条全部被认领', cat.rows.length, 600)
    eq('无 unmapped', cat.unmapped.length, 0)
    ok('墓碑身份保留 → 宿主行不被误删', `rows=${cat.rows.length}`)
  }

  say('')
  say('=== D) M-5：矛盾态（宿主行 active + 有回执）是否被删 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hm = M.openHostMap({ filePath: join(dir, 'd.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'contra', fireAtMs: BASE + MIN, title: 'C', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])
    // 造矛盾态：行仍是 active，但 history 有回执
    const id = [...stub._tasks.keys()][0]
    stub._tasks.get(id).deliveryHistory = {
      records: [{ scheduledAt: new Date(BASE + MIN).toISOString(), deliveredAt: new Date(BASE + MIN).toISOString(), messageId: 'm1' }],
      earlierRecordsUnavailable: false,
    }
    stub._tasks.get(id).status = 'active'   // 仍是 active
    const recovery = M.createReminderRecovery({ adapter, now: () => BASE })
    const res = await recovery.recover([plan], { scenario: 'restart', atMs: BASE })
    const cat = await stub.catalog()
    say(`     recover: alreadyDelivered=${JSON.stringify(res.alreadyDelivered)} removed=${JSON.stringify(res.removed)} 宿主行=${cat.length} 状态=${cat[0]?.status}`)
    if (cat.length === 0) {
      bad('矛盾态（active + 有回执）下宿主行被删', '宿主行=0')
    } else {
      ok('矛盾态下宿主行保留', `宿主行=${cat.length}`)
    }
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-10 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

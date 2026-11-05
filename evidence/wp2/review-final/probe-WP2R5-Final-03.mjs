#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 03：500 条映射裁剪 + index 增长 + 跨重启 + 交错 scope。
 *
 * 任务书第 4 项。刻意比 scripts/probes/p3-retention.mjs 更严：
 *   - 2000 条（不是 600）
 *   - 3 次「重启」（每次重新 openHostMap 从磁盘读）
 *   - 交错 scope（events / tasks 交错建），验证 scope 隔离与裁剪叠加后仍成立
 *   - **额外**：单独度量 hostmap.json 文件体积随「历史累计创建条数」的增长曲线，
 *     检验 index 是否无上限（任务书明确点名的关键问题）
 *
 * 直接 import 冻结目录源码。
 */
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'r5p3-'))
const sizeOf = (p) => { try { return statSync(p).size } catch { return -1 } }

try {
  const stub = createContractStub({ now: () => BASE })
  const mapPath = join(dir, 'm.json')
  let hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
  const mkAdapter = () => M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
  })

  say('=== WP2R5-Final 探针 03：500 裁剪 / index 增长 / 跨重启 / 交错 scope ===')
  say('')

  // ---------- A) 交错 scope 建 2000 条 ----------
  say('--- A) 交错 scope 建 2000 条（events / tasks 交替建，两个 scope 各自一次对账）---')
  const N = 2000
  const mkPlan = (i) => ({
    reminderKey: `k-${String(i).padStart(5, '0')}`,
    fireAtMs: BASE + (i + 1) * MIN,
    title: `T${i}`,
    prompt: 'p',
    kind: 'event-start',
  })
  const all = Array.from({ length: N }, (_, i) => mkPlan(i))
  // 正确用法：按 scope 分成两组，**各自**一次对账（scope 写在同一次调用的所有 plan 上）
  const eventsOnly = all.filter((_, i) => i % 2 === 0)
  const tasksOnly = all.filter((_, i) => i % 2 === 1)
  await mkAdapter().reconcile(eventsOnly, { scope: 'events' })
  await mkAdapter().reconcile(tasksOnly, { scope: 'tasks' })
  eq('宿主侧 2000 条', (await stub.catalog()).length, N)
  eq('本地 entries 被裁到 500', hostMap.size, 500)

  // ---------- B) 全部可认领（身份索引生效） ----------
  say('')
  say('--- B) 裁剪后仍全部可认领 ---')
  const cat = await mkAdapter().catalog()
  eq('catalog 认领 2000 条', cat.rows.length, N)
  eq('无 unmapped', cat.unmapped.length, 0)
  eq('needsAttention=false', cat.needsAttention, false)

  // ---------- C) 再次对账：不得删、不得重建 ----------
  say('')
  say('--- C) 再次对账（events scope 一次 + tasks scope 一次）---')
  const r2 = await mkAdapter().reconcile(eventsOnly, { scope: 'events' })
  eq('events 对账：未删除', r2.removed.length, 0)
  eq('events 对账：未重复创建', r2.created.length, 0)
  const r2b = await mkAdapter().reconcile(tasksOnly, { scope: 'tasks' })
  eq('tasks 对账：未删除', r2b.removed.length, 0)
  eq('tasks 对账：未重复创建', r2b.created.length, 0)
  eq('宿主仍 2000', (await stub.catalog()).length, N)

  // ---------- D) 跨 3 次重启 ----------
  say('')
  say('--- D) 跨 3 次重启（每次从磁盘重开 hostMap）---')
  for (let r = 0; r < 3; r += 1) {
    hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
    eq(`重启 ${r + 1}：entries 仍 500`, hostMap.size, 500)
    const res = await mkAdapter().reconcile(eventsOnly, { scope: 'events' })
    eq(`重启 ${r + 1}：未删除`, res.removed.length, 0)
    eq(`重启 ${r + 1}：未重复创建`, res.created.length, 0)
    const res2 = await mkAdapter().reconcile(tasksOnly, { scope: 'tasks' })
    eq(`重启 ${r + 1}(tasks)：未删除`, res2.removed.length, 0)
    eq(`重启 ${r + 1}(tasks)：未重复创建`, res2.created.length, 0)
    eq(`重启 ${r + 1}：宿主仍 2000`, (await stub.catalog()).length, N)
    const c = await mkAdapter().catalog()
    eq(`重启 ${r + 1}：认领 2000`, c.rows.length, N)
  }

  // ---------- E) scope 隔离在裁剪后仍成立 ----------
  say('')
  say('--- E) 交错 scope 在裁剪后仍隔离 ---')
  const ev = await mkAdapter().reconcile(eventsOnly, { scope: 'events' })
  eq('只对账 events：不删 tasks 的', ev.removed.length, 0)
  eq('宿主仍 2000', (await stub.catalog()).length, N)

  // ---------- F) 被裁掉的条目重新出现时：复用而非重建 ----------
  say('')
  say('--- F) 被裁掉的条目重新出现 ---')
  const orphan = all[0]
  const r6 = await mkAdapter().reconcile([orphan, ...eventsOnly.slice(1)], { scope: 'events' })
  eq('未重复创建', r6.created.length, 0)
  eq('宿主仍 2000', (await stub.catalog()).length, N)

  // ---------- G) 关键问题：index 是否无上限？文件体积曲线 ----------
  say('')
  say('--- G) index 增长与文件体积曲线（每轮再建 1000 条新提醒）---')
  const curve = []
  for (let round = 0; round < 4; round += 1) {
    const batch = []
    for (let i = 0; i < 1000; i += 1) {
      batch.push({
        reminderKey: `round${round}-${String(i).padStart(4, '0')}`,
        fireAtMs: BASE + (round * 1000 + i + 1) * MIN,
        title: `R${round}T${i}`,
        prompt: 'p',
        kind: 'event-start',
      })
    }
    await mkAdapter().reconcile(batch, { scope: 'events' })
    const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
    curve.push({
      round,
      累计创建: N + (round + 1) * 1000,
      entries: Object.keys(raw.entries).length,
      index: Object.keys(raw.index).length,
      bytes: sizeOf(mapPath),
    })
  }
  for (const c of curve) {
    say(`    累计创建 ${String(c.累计创建).padStart(5)} → entries=${String(c.entries).padStart(4)} index=${String(c.index).padStart(5)} 文件=${String(c.bytes).padStart(7)} 字节`)
  }
  const last = curve[curve.length - 1]
  const first = curve[0]
  say('')
  say(`    index 从 ${first.index} 涨到 ${last.index}（累计创建 ${first.累计创建}→${last.累计创建}）`)
  const indexUnbounded = last.index > 500
  if (indexUnbounded) {
    bad(`index 无上限：${last.index} > maxEntries=500（文件 ${last.bytes} 字节，且随累计创建量单调增长）`)
  } else {
    ok(`index 受上限约束：${last.index} <= 500`)
  }

  // ---------- H) index 无上限会不会造成「认不出 → 重复创建」 ----------
  say('')
  say('--- H) index 溢出后是否仍能认领旧行（重复创建风险）---')
  const c2 = await mkAdapter().catalog()
  eq('catalog 认领全部宿主行', c2.rows.length, (await stub.catalog()).length)
  eq('无 unmapped（未因 index 溢出而认不出）', c2.unmapped.length, 0)

  // ---------- I) 体积是否已构成实际问题 ----------
  say('')
  say('--- I) 体积评估 ---')
  const perEntry = last.index > 0 ? last.bytes / last.index : 0
  say(`    平均每个 index 身份约 ${perEntry.toFixed(1)} 字节`)
  say(`    外推：10 万条累计创建 → 约 ${(perEntry * 100000 / 1024 / 1024).toFixed(1)} MB`)
  say(`    外推：100 万条累计创建 → 约 ${(perEntry * 1000000 / 1024 / 1024).toFixed(1)} MB`)
} catch (error) {
  bad('探针 03 异常', String(error?.stack ?? error).slice(0, 600))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

say('')
say(`=== 探针 03 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

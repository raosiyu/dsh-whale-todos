#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 05：裁剪（墓碑）后，**不再需要的提醒还能被删掉吗**？
 *
 * 背景：host-map.js 的裁剪把超出 maxEntries 的条目从 `entries` 移出，
 * 但把身份（hostId ↔ reminderKey）留在 `index`（墓碑）。
 *
 * 两个后果需要分别验证：
 *   (a) 全量对账（无 scope）：墓碑行的 scope 退化为 ''，但仍进 existingKeys →
 *       backend.remove(reminderKey) → hostMap.get(reminderKey) 返回 undefined
 *       → {ok:false, reason:'not-found'} → 宿主那一行**删不掉**。
 *   (b) 带 scope 对账：墓碑行 scope='' ≠ scope → 直接被 inScopeRow 过滤掉 →
 *       同样**删不掉**，且不进 existingKeys，连 failed 都不记。
 *
 * 后果：超过 500 条之后，**用户已经取消/删除的事件的提醒永远留在宿主上、永远会响**。
 *
 * 判据：
 *   - 期望：不再 desired 的宿主行被删掉（removed>0，宿主行数下降）
 *   - 若删不掉 → 严重缺陷（用户数据无法回收 / 幽灵提醒）
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'r5p5-'))
try {
  const stub = createContractStub({ now: () => BASE })
  const mapPath = join(dir, 'm.json')
  const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
  const mk = (i) => ({
    reminderKey: `k-${String(i).padStart(5, '0')}`,
    fireAtMs: BASE + (i + 1) * MIN,
    title: `T${i}`, prompt: 'p', kind: 'event-start',
  })
  const mkAdapter = () => M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
  })

  say('=== WP2R5-Final 探针 05：裁剪后能否删除不再需要的提醒 ===')
  say('')

  // ---- 建 600 条（超过 maxEntries=500 → 100 条变墓碑） ----
  const all = Array.from({ length: 600 }, (_, i) => mk(i))
  const r1 = await mkAdapter().reconcile(all)
  eq('建立 600 条', r1.created.length, 600)
  eq('宿主 600 条', (await stub.catalog()).length, 600)
  eq('entries 裁到 500', hostMap.size, 500)

  // 哪些 key 变墓碑了？
  const tombstones = all.map((p) => p.reminderKey).filter((k) => hostMap.get(k) === undefined)
  say(`    变墓碑的 key 数: ${tombstones.length}`)
  say(`    示例墓碑: ${tombstones.slice(0, 3).join(', ')}`)

  // ---- 场景 A：全量对账，但 desired 里去掉一半（用户取消了这些事件） ----
  say('')
  say('--- A) 全量对账：desired 只剩后 300 条（前半被用户取消）---')
  const keep = all.slice(300)
  const rA = await mkAdapter().reconcile(keep)
  eq('removed 计数 > 0', rA.removed.length > 0 ? 1 : 0, 1)
  say(`    removed=${rA.removed.length} failed=${rA.failed.length} 宿主行=${(await stub.catalog()).length}`)
  const reasons = {}
  for (const f of rA.failed) reasons[`${f.reason}/${f.op ?? '?'}`] = (reasons[`${f.reason}/${f.op ?? '?'}`] ?? 0) + 1
  say(`    failed 原因分布: ${JSON.stringify(reasons)}`)
  const hostAfterA = (await stub.catalog()).length
  if (hostAfterA > keep.length) {
    bad(`删除失效：desired=${keep.length} 条，宿主仍有 ${hostAfterA} 条（幽灵提醒会继续响）`,
      `removed=${rA.removed.length} failed=${rA.failed.length}`)
  } else {
    ok(`删除生效：宿主降到 ${hostAfterA} 条`)
  }

  // ---- 场景 B：带 scope 对账 ----
  say('')
  say('--- B) 带 scope 对账：desired 只剩 scope 内的一半 ---')
  const dir2 = mkdtempSync(join(tmpdir(), 'r5p5b-'))
  try {
    const stub2 = createContractStub({ now: () => BASE })
    const hostMap2 = M.openHostMap({ filePath: join(dir2, 'm.json'), maxEntries: 500 })
    const mkAdapter2 = () => M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub2, hostMap: hostMap2, sessionId: 's1', now: () => BASE,
    })
    const all2 = Array.from({ length: 600 }, (_, i) => mk(i))
    await mkAdapter2().reconcile(all2, { scope: 'events' })
    eq('scope 建 600 条', (await stub2.catalog()).length, 600)
    const tombs2 = all2.map((p) => p.reminderKey).filter((k) => hostMap2.get(k) === undefined)
    say(`    变墓碑的 key 数: ${tombs2.length}`)

    const keep2 = all2.slice(300)
    const rB = await mkAdapter2().reconcile(keep2, { scope: 'events' })
    const hostAfterB = (await stub2.catalog()).length
    say(`    removed=${rB.removed.length} failed=${rB.failed.length} 宿主行=${hostAfterB}`)
    if (hostAfterB > keep2.length) {
      bad(`带 scope 时删除失效：desired=${keep2.length}，宿主仍有 ${hostAfterB} 条`)
    } else {
      ok(`带 scope 时删除生效：宿主降到 ${hostAfterB} 条`)
    }
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }

  // ---- 场景 C：对照——未超上限（300 条）时删除是否正常 ----
  say('')
  say('--- C) 对照组：300 条（未超上限）删除是否正常 ---')
  const dir3 = mkdtempSync(join(tmpdir(), 'r5p5c-'))
  try {
    const stub3 = createContractStub({ now: () => BASE })
    const hostMap3 = M.openHostMap({ filePath: join(dir3, 'm.json'), maxEntries: 500 })
    const mkAdapter3 = () => M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub3, hostMap: hostMap3, sessionId: 's1', now: () => BASE,
    })
    const all3 = Array.from({ length: 300 }, (_, i) => mk(i))
    await mkAdapter3().reconcile(all3)
    const rC = await mkAdapter3().reconcile(all3.slice(150))
    eq('对照组 removed=150', rC.removed.length, 150)
    eq('对照组宿主降到 150', (await stub3.catalog()).length, 150)
  } finally {
    rmSync(dir3, { recursive: true, force: true })
  }
} catch (error) {
  bad('探针 05 异常', String(error?.stack ?? error).slice(0, 600))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

say('')
say(`=== 探针 05 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

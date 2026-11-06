#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 06：
 *   (A) 墓碑删除缺陷在【冻结版 2b0aabb】与【主仓库 HEAD 8c264b1】是否都存在
 *   (B) 冻结版 hostMap.put 的写放大（每次 put 重写整份文件）实测
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const LIVE = '<repo>'
const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000

let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }

async function tombstoneTest(label, srcRoot) {
  const M = await import(`${srcRoot}/workbench-core/src/index.js`)
  const { createContractStub } = await import(`${srcRoot}/workbench-core/test/helpers/contract-stub.mjs`)
  const dir = mkdtempSync(join(tmpdir(), 'r5p6-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(5, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const all = Array.from({ length: 600 }, (_, i) => mk(i))
    await adapter.reconcile(all)
    const keep = all.slice(300)
    const r = await adapter.reconcile(keep)
    const hostRows = (await stub.catalog()).length
    const ghosts = hostRows - keep.length
    say(`  ${label}: removed=${r.removed.length} failed=${r.failed.length} 宿主行=${hostRows} 幽灵=${ghosts}`)
    const reasons = {}
    for (const f of r.failed) reasons[f.reason ?? '?'] = (reasons[f.reason ?? '?'] ?? 0) + 1
    say(`    failed 原因: ${JSON.stringify(reasons)}`)
    return { ghosts, failed: r.failed.length, hostRows }
  } catch (error) {
    bad(`${label} 异常`, String(error?.stack ?? error).slice(0, 400))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function writeCostTest(label, srcRoot) {
  const M = await import(`${srcRoot}/workbench-core/src/index.js`)
  const dir = mkdtempSync(join(tmpdir(), 'r5p6w-'))
  try {
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
    const N = 2000
    const t0 = Date.now()
    for (let i = 0; i < N; i += 1) {
      hostMap.put({
        reminderKey: `k-${String(i).padStart(5, '0')}`,
        hostId: `schedule-${i}`, sessionId: 's1',
        fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, kind: 'event-start', scope: 'events',
      })
    }
    const ms = Date.now() - t0
    say(`  ${label}: ${N} 次 put 耗时 ${ms} ms`)
    return ms
  } catch (error) {
    bad(`${label} 写放大异常`, String(error?.stack ?? error).slice(0, 400))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('=== WP2R5-Final 探针 06：墓碑删除缺陷 + 写放大 ===')
say('')
say('--- A) 墓碑删除缺陷（>500 条后，不再需要的提醒删不掉）---')
const f = await tombstoneTest('冻结版 2b0aabb', FREEZE)
say('')
const l = await tombstoneTest('主仓库 HEAD 8c264b1', LIVE)
say('')
if (f && l) {
  if (f.ghosts > 0) bad(`冻结版存在幽灵提醒：${f.ghosts} 条删不掉`)
  else ok('冻结版无幽灵提醒')
  if (l.ghosts > 0) bad(`主仓库 HEAD 仍存在幽灵提醒：${l.ghosts} 条删不掉`)
  else ok('主仓库 HEAD 无幽灵提醒')
}

say('')
say('--- B) hostMap.put 写放大（每次 put 重写整份文件）---')
const wf = await writeCostTest('冻结版 2b0aabb', FREEZE)
say('')
const wl = await writeCostTest('主仓库 HEAD 8c264b1', LIVE)
say('')
if (wf && wl) say(`  比值：冻结版是 HEAD 的 ${(wf / wl).toFixed(1)} 倍`)

say('')
say(`=== 探针 06 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

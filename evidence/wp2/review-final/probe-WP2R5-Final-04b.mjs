#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 04b：裁剪后的**同一批 key** 再对账（正确判据）。
 *
 * 探针 04 的期望写错了：第二轮用的 `n-*` 是**新 key**，创建它们是正确的。
 * 正确判据是：**同一批 key** 再对账一次，必须 created=0（复用而非重建）。
 *
 * 同时对比冻结版与主仓库工作副本。
 */
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
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
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

async function scenario(label, srcRoot) {
  const M = await import(`${srcRoot}/workbench-core/src/index.js`)
  const { createContractStub } = await import(`${srcRoot}/workbench-core/test/helpers/contract-stub.mjs`)
  const dir = mkdtempSync(join(tmpdir(), 'r5p4b-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const mapPath = join(dir, 'm.json')
    let hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(5, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const mkAdapter = () => M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    say(`--- ${label} ---`)

    const all = Array.from({ length: 1000 }, (_, i) => mk(i))
    const r1 = await mkAdapter().reconcile(all)
    eq('第一轮建立 1000 条', r1.created.length, 1000)
    eq('宿主 1000 条', (await stub.catalog()).length, 1000)

    // **同一批 key** 再对账（不新增）
    const r2 = await mkAdapter().reconcile(all)
    eq('第二轮（同批 key）：created=0', r2.created.length, 0)
    eq('第二轮：宿主仍 1000 条', (await stub.catalog()).length, 1000)
    eq('第二轮：removed=0', r2.removed.length, 0)

    // 重启后再对账同一批
    hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
    const r3 = await mkAdapter().reconcile(all)
    eq('重启后对账：created=0', r3.created.length, 0)
    eq('重启后：宿主仍 1000 条', (await stub.catalog()).length, 1000)

    const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
    const indexSize = Object.keys(raw.index).length
    const entriesSize = Object.keys(raw.entries).length
    const bytes = statSync(mapPath).size
    say(`    entries=${entriesSize} index=${indexSize} 文件=${bytes} 字节`)

    const cat = await mkAdapter().catalog()
    eq('仍全部可认领（unmapped=0）', cat.unmapped.length, 0)
    eq('认领 1000 条', cat.rows.length, 1000)
    return { indexSize, entriesSize, bytes }
  } catch (error) {
    bad(`${label} 异常`, String(error?.stack ?? error).slice(0, 500))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('=== WP2R5-Final 探针 04b：同批 key 再对账（正确判据）===')
say('')
const frozen = await scenario('冻结版 2b0aabb', FREEZE)
say('')
const live = await scenario('主仓库工作副本（当前 HEAD+未提交）', LIVE)
say('')
if (frozen && live) {
  say(`冻结版： entries=${frozen.entriesSize} index=${frozen.indexSize} 文件=${frozen.bytes}B`)
  say(`主仓库： entries=${live.entriesSize} index=${live.indexSize} 文件=${live.bytes}B`)
}
say('')
say(`=== 探针 04b 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

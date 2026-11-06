#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 04：主仓库未提交的「index 封顶」修复是否重新引入重复创建。
 *
 * 背景：冻结版 2b0aabb 的 host-map.js 只对 entries 封顶，index 无上限（我在探针 03 测到
 * index 随累计创建量单调增长 → 6000 条时文件 297 KB）。
 * 主仓库工作副本有一段**未提交**的修复：prune() 里也把 index 裁到 maxEntries。
 *
 * R5-1 的 commit message 明确说：
 *   「pruning the local map used to DROP entries outright. The dropped keys then
 *     looked absent from the host, so the next reconcile created a second copy.
 *     ... The map now keeps a bounded entries table plus a separate identity index
 *     (hostId -> reminderKey), so pruning caps the entry count without losing the
 *     ability to recognise a host row.」
 *
 * **但如果 index 也被裁，那么「认出宿主上的行」这个能力又没了** →
 * 被裁身份的宿主行变成 unmapped → 不在 existingKeys → reconcile 认为「宿主没有这条」
 * → **再建一份** → 重复投递。
 *
 * 本探针同时跑冻结版与主仓库工作版，用同一场景对比。
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
  const dir = mkdtempSync(join(tmpdir(), 'r5p4-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const mapPath = join(dir, 'm.json')
    const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
    const mk = (i, prefix = 'k') => ({
      reminderKey: `${prefix}-${String(i).padStart(5, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const mkAdapter = () => M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })

    say(`--- ${label} ---`)

    // 第一轮：建 1000 条（超过 maxEntries=500）
    const first = Array.from({ length: 1000 }, (_, i) => mk(i))
    const r1 = await mkAdapter().reconcile(first)
    eq('第一轮建立 1000 条', r1.created.length, 1000)
    eq('宿主 1000 条', (await stub.catalog()).length, 1000)

    // 第二轮：再建 1000 条新的（不同 key），旧的仍在 desired 里
    const second = Array.from({ length: 1000 }, (_, i) => mk(i, 'n'))
    const r2 = await mkAdapter().reconcile([...first, ...second])
    eq('第二轮：不应重复创建任何一条', r2.created.length, 0)
    eq('第二轮：宿主仍 1000 条', (await stub.catalog()).length, 1000)

    const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
    const indexSize = Object.keys(raw.index).length
    const entriesSize = Object.keys(raw.entries).length
    const bytes = statSync(mapPath).size
    say(`    entries=${entriesSize} index=${indexSize} 文件=${bytes} 字节`)

    const cat = await mkAdapter().catalog()
    eq('仍全部可认领（无 unmapped）', cat.unmapped.length, 0)

    return { indexSize, entriesSize, bytes, r2created: r2.created.length, hostRows: cat.rows.length }
  } catch (error) {
    bad(`${label} 异常`, String(error?.stack ?? error).slice(0, 500))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('=== WP2R5-Final 探针 04：index 封顶 vs 重复创建 ===')
say('')

const frozen = await scenario('冻结版 2b0aabb（index 不封顶）', FREEZE)
say('')
const live = await scenario('主仓库工作副本（index 封顶，未提交）', LIVE)

say('')
say('=== 对比 ===')
if (frozen && live) {
  say(`冻结版： index=${frozen.indexSize} created=${frozen.r2created} 宿主行=${frozen.hostRows} 文件=${frozen.bytes}B`)
  say(`主仓库： index=${live.indexSize} created=${live.r2created} 宿主行=${live.hostRows} 文件=${live.bytes}B`)
  if (live.r2created > 0) {
    bad(`主仓库的 index 封顶修复重新引入了重复创建：第二轮 created=${live.r2created}（应为 0）`)
  } else {
    ok('主仓库的 index 封顶未导致重复创建')
  }
}

say('')
say(`=== 探针 04 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

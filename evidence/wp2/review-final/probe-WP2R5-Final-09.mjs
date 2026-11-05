#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 09：并发重复创建缺陷的精确刻画。
 *
 * 探针 08-C 显示：两个 reconcile 并发、desired **部分重叠**时，
 * 重叠的那 10 条被建了**两份** → 用户会收到两次提醒。
 *
 * 机制：reconcile 的流程是
 *   1) catalog()  ← 快照
 *   2) 对 desired 里不在 existingKeys 的 → backend.upsert() → hostSchedule.create()
 * 两个 reconcile **同时**做第 1 步时，各自都看到「shared 的 10 条不存在」，
 * 于是各自 create 一次 → 两份。
 *
 * 这是典型的 check-then-act 竞态（TOCTOU）。
 *
 * 本探针精确刻画：
 *   - 重叠部分产生几份？
 *   - 是否每次都复现？
 *   - 主仓库 HEAD 是否也这样？
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const LIVE = '/Users/sylas/Developer/dsh-workbench'
const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000
let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }

async function trial(srcRoot, label, rounds = 5) {
  const M = await import(`${srcRoot}/workbench-core/src/index.js`)
  const { createContractStub } = await import(`${srcRoot}/workbench-core/test/helpers/contract-stub.mjs`)
  const results = []
  for (let r = 0; r < rounds; r += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'r5p9-'))
    try {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
      const adapter = M.createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      const mk = (i) => ({
        reminderKey: `k-${String(i).padStart(3, '0')}`,
        fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
      })
      const shared = Array.from({ length: 10 }, (_, i) => mk(i))
      const onlyA = Array.from({ length: 10 }, (_, i) => mk(200 + i))
      const onlyB = Array.from({ length: 10 }, (_, i) => mk(300 + i))
      await Promise.all([
        adapter.reconcile([...shared, ...onlyA]),
        adapter.reconcile([...shared, ...onlyB]),
      ])
      const rows = await stub.catalog()
      const titles = rows.map((x) => x.title)
      const dupCount = titles.length - new Set(titles).size
      results.push({ hostRows: rows.length, dup: dupCount })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  say(`  ${label}:`)
  for (const r of results) say(`    宿主行=${r.hostRows} 重复条数=${r.dup}`)
  const dupTotal = results.reduce((a, b) => a + b.dup, 0)
  const maxDup = Math.max(...results.map((r) => r.dup))
  say(`    ${rounds} 轮中最大重复 = ${maxDup}，累计重复 = ${dupTotal}`)
  return { maxDup, dupTotal, rounds }
}

say('=== WP2R5-Final 探针 09：并发重复创建（TOCTOU）精确刻画 ===')
say('')
const f = await trial(FREEZE, '冻结版 2b0aabb')
say('')
const l = await trial(LIVE, '主仓库 HEAD 8c264b1')
say('')
say('=== 判定 ===')
if (f.maxDup > 0) {
  bad(`冻结版存在并发重复投递：最大重复 ${f.maxDup} 条（用户会收到两次同一提醒）`)
} else ok('冻结版无并发重复')
if (l.maxDup > 0) {
  bad(`主仓库 HEAD 同样存在并发重复投递：最大重复 ${l.maxDup} 条`)
} else ok('主仓库 HEAD 无并发重复')

say('')
say(`=== 探针 09 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

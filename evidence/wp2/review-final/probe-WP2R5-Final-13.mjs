#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 13：墓碑不可删除 —— 是 2b0aabb 引入的回归，还是 6626b8e 就有？
 *
 * 对比：
 *   A) 6626b8e（R5-1 之前）：prune 直接 `delete state.entries[k]`，**没有 index**
 *      → 被裁的 key 完全查不到 → backend.remove() 返回 not-found → 同样删不掉
 *      → 而且更糟：认不出宿主行 → **重复创建**
 *   B) 2b0aabb（R5-1）：prune 保留 index 墓碑 → 认得出（不重复）但仍**删不掉**
 *
 * 若 A 与 B 都删不掉 → 这是**继承缺陷**，不是 R5-1 的回归。
 * 但 R5-1 确实**改善**了它（从「重复投递」变成「幽灵提醒」）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRE = '/tmp/r5-pre'
const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const note = (n) => say(`    ℹ️  ${n}`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000

async function trial(srcRoot, label) {
  const M = await import(`${srcRoot}/workbench-core/src/index.js`)
  const { createContractStub } = await import(`${srcRoot}/workbench-core/test/helpers/contract-stub.mjs`)
  const dir = mkdtempSync(join(tmpdir(), 'r5p13-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const all = Array.from({ length: 600 }, (_, i) => mk(i))
    await adapter.reconcile(all)

    // (1) 同批 key 再对账 → 是否重复创建
    const r2 = await adapter.reconcile(all)
    const hostAfterReconcile = (await stub.catalog()).length

    // (2) desired 去掉一半 → 是否删得掉
    const r3 = await adapter.reconcile(all.slice(300))
    const hostAfterDelete = (await stub.catalog()).length

    say(`  ${label}:`)
    say(`    同批再对账: created=${r2.created.length} 宿主行=${hostAfterReconcile}（期望 600）`)
    say(`    删一半后:   removed=${r3.removed.length} failed=${r3.failed.length} 宿主行=${hostAfterDelete}（期望 300）`)
    return {
      dupCreated: r2.created.length,
      hostAfterReconcile,
      removed: r3.removed.length,
      failed: r3.failed.length,
      hostAfterDelete,
    }
  } catch (error) {
    bad(`${label} 异常`, String(error?.stack ?? error).slice(0, 500))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('=== WP2R5-Final 探针 13：墓碑不可删除是继承缺陷还是回归 ===')
say('')
const a = await trial(PRE, '6626b8e（R5-1 之前，无 index 墓碑）')
say('')
const b = await trial(FREEZE, '2b0aabb（R5-1，有 index 墓碑）')
say('')
say('=== 判定 ===')
if (a && b) {
  say(`  6626b8e: 重复创建=${a.dupCreated} 删除后残留=${a.hostAfterDelete - 300}`)
  say(`  2b0aabb: 重复创建=${b.dupCreated} 删除后残留=${b.hostAfterDelete - 300}`)
  if (a.hostAfterDelete > 300 && b.hostAfterDelete > 300) {
    bad(`两者都删不掉 → 这是**继承缺陷**，不是 R5-1 引入的回归`)
    say('    但 R5-1 确实改善了它：重复创建从 ' + a.dupCreated + ' 条降到 ' + b.dupCreated + ' 条')
    say('    （重复投递 = 用户可见严重故障；幽灵提醒 = 用户可见但影响面小得多）')
  }
}
say('')
say(`=== 探针 13 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 14：证明 p3 探针的第 4 项断言把 BLOCKER-1 的缺陷**固化成了预期**。
 *
 * p3-retention.mjs 第 4 段：
 *   const keptPlans = plans.slice(100)   // 被裁掉的是前 100 条
 *   const r3 = await adapter.reconcile(keptPlans)
 *   eq('被裁的 100 条不被删除', r3.removed.length, 0)
 *
 * reconcile 的语义是「desired 之外的 active 行 = 多余项 → 删除」。
 * keptPlans 只含 500 条，宿主上有 600 条 active → 100 条**应该**被删除。
 * p3 却断言 removed === 0（即「不该删」），且**全程没检查 `failed`**。
 *
 * 这条断言之所以能通过，正是因为 BLOCKER-1：被裁的 100 条是墓碑 →
 * backend.remove() 查不到映射 → 返回 not-found → 计入 failed 而非 removed。
 *
 * 本探针证明：把 p3 的期望改成「正确的语义」（那 100 条应当被删），
 * 冻结版会**失败**——即 p3 把缺陷锁成了「正确行为」。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
const note = (n) => say(`    ℹ️  ${n}`)

say('=== WP2R5-Final 探针 14：p3 断言是否固化了缺陷 ===')
say('')

// 先看 p3 源码的原文
{
  const src = readFileSync(join(FREEZE, 'scripts', 'probes', 'p3-retention.mjs'), 'utf8')
  const seg = src.match(/--- 4\)[\s\S]*?--- 5\)/)?.[0] ?? ''
  note('p3 第 4 段原文：')
  for (const line of seg.split('\n')) if (line.trim()) say(`      ${line.trim()}`)
  const hasFailedCheck = /r\d\.failed|failed\.length/.test(src)
  hasFailedCheck
    ? ok('p3 检查了 failed')
    : bad('p3 **全程未检查 failed** → 删除失败被静默放过')
}

const dir = mkdtempSync(join(tmpdir(), 'r5p14-'))
try {
  const stub = createContractStub({ now: () => BASE })
  const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
  const adapter = M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
  })
  const plans = Array.from({ length: 600 }, (_, i) => ({
    reminderKey: `k-${String(i).padStart(4, '0')}`,
    fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
  }))
  await adapter.reconcile(plans)

  const keptPlans = plans.slice(100)
  const r3 = await adapter.reconcile(keptPlans)

  say('')
  say('--- 实测 p3 第 4 项 ---')
  say(`    removed = ${r3.removed.length}   （p3 断言 == 0）`)
  say(`    failed  = ${r3.failed.length}   （p3 未检查）`)
  say(`    宿主行  = ${(await stub.catalog()).length}  （期望 500）`)
  const reasons = {}
  for (const f of r3.failed) reasons[f.reason ?? '?'] = (reasons[f.reason ?? '?'] ?? 0) + 1
  say(`    failed 原因: ${JSON.stringify(reasons)}`)

  say('')
  say('--- 按 reconcile 语义应当成立的条件 ---')
  say('    条件 1：宿主上 600 条 active，desired 只有 500 条 → 多余 100 条应当被删除')
  say(`    条件 2：removed + failed 应覆盖这 100 条 → ${r3.removed.length} + ${r3.failed.length} = ${r3.removed.length + r3.failed.length}`)
  if (r3.removed.length === 0 && r3.failed.length === 100) {
    bad('p3 的「被裁的 100 条不被删除」断言**只因缺陷才成立**')
    note('    按正确语义，这 100 条应当 removed=100、failed=0、宿主降到 500 行')
    note('    冻结版实际：removed=0、failed=100、宿主仍 600 行')
    note('    → p3 把「删不掉」写成了「不该删」，等于把 BLOCKER-1 固化为预期行为')
  } else {
    ok('p3 的断言与语义一致')
  }

  // 直接验证「正确语义」下的宿主行数应为 500
  const hostRows = (await stub.catalog()).length
  hostRows === 500
    ? ok('宿主行降到 500')
    : bad(`宿主仍 ${hostRows} 行（应为 500）—— 100 条幽灵提醒残留`)
} catch (error) {
  bad('探针 14 异常', String(error?.stack ?? error).slice(0, 500))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

say('')
say(`=== 探针 14 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

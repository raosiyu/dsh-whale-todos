#!/usr/bin/env node
/**
 * 探针 R5b-11：确认新 p3 的语义是「被裁且不在 desired 的条目应当被删除」
 * 任务书明确要求：不要只读代码，要确认新 p3 是这个语义，且检查 failed[]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

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
const dir = mkdtempSync(join(tmpdir(), 'r5b11-'))
try {
  say('=== A) 新 p3 的源码断言（语义 + failed 检查）===')
  const src = readFileSync(`${FREEZE}/scripts/probes/p3-retention.mjs`, 'utf8')
  const lines = src.split('\n')
  const failedAsserts = lines
    .map((l, i) => ({ i: i + 1, l }))
    .filter((x) => /failed\.length/.test(x.l))
  say(`     p3 里检查 failed[] 的断言共 ${failedAsserts.length} 处：`)
  for (const x of failedAsserts) say(`       L${x.i}: ${x.l.trim()}`)
  if (failedAsserts.length === 0) bad('p3 仍未检查 failed[]', '0 处')
  else ok('p3 检查 failed[]', `${failedAsserts.length} 处`)

  // 语义断言：被裁的 100 条应当被删除
  const semanticsOk = /被裁的 100 条被删除/.test(src) && /removed\.length, 100/.test(src)
  if (semanticsOk) ok('p3 的新语义是「被裁且不在 desired 的条目应当被删除」', 'removed.length === 100')
  else bad('p3 的语义未改为「应当被删除」', src.match(/被裁.{0,20}/g)?.join(' | '))

  // 旧的错误预期（「被裁的 100 条不被删除」）不应残留
  const oldBad = /被裁的 100 条不被删除/.test(src)
  if (oldBad) bad('p3 仍保留旧的错误预期', 'found')
  else ok('p3 不再断言「被裁的 100 条不被删除」')

  say('')
  say('=== B) 独立复现新 p3 第 4 段的语义（不依赖 p3 本身）===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'a.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 600 }, (_, i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    const r1 = await adapter.reconcile(plans)
    eq('600 条全部建立', r1.created.length, 600)
    eq('宿主侧 600 条', (await stub.catalog()).length, 600)
    eq('本地映射被裁到 500', hostMap.size, 500)
    eq('无失败', r1.failed.length, 0)

    // 第 4 段：只对账保留的 500 条 → 被裁的 100 条应当被删除
    const keptPlans = plans.slice(100)
    const r3 = await adapter.reconcile(keptPlans)
    eq('被裁的 100 条被删除', r3.removed.length, 100)
    eq('删除无失败', r3.failed.length, 0)
    eq('宿主侧降到 500 条', (await stub.catalog()).length, 500)
    eq('仍全部可认领', (await adapter.catalog()).unmapped.length, 0)
  }

  say('')
  say('=== C) p3 第 5 段的语义：被删除的提醒重新出现 → 重建（正确）===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'b.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 600 }, (_, i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    const kept = plans.slice(100)
    await adapter.reconcile(kept)
    eq('宿主 500 条', (await stub.catalog()).length, 500)
    // k-0 被删了 → 重新出现应重建
    const r4 = await adapter.reconcile([plans[0]])
    eq('已删除的提醒重新出现 → 重建', r4.created.length, 1)
    eq('无失败', r4.failed.length, 0)
    eq('宿主侧恰好 1 条（不重复）', (await stub.catalog()).length, 1)
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-11 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

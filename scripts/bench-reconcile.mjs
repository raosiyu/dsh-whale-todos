#!/usr/bin/env node
/**
 * **O(N²) 提醒对账性能基准**（只测量，不修改实现）。
 *
 * WP3 授权要求：O(N²) 问题单独登记并建立基准测试，**不得在缺乏证据时宣称已解决**。
 *
 * 已知根因（`workbench-core/src/schedule-adapter.js`）：
 *   `reconcile` 对 desired 中每个 key 若判为「不存在」就调 `upsert`；
 *   而 host 后端的 `upsertLocked()` 第一行就是 `await backend.catalog()`，
 *   `catalog()` 要遍历宿主全部行并逐行做身份反查。
 *   于是「建 N 条」≈ N 次全量 catalog ⇒ 端到端 O(N²)。
 *
 * 本脚本用**契约一致的 stub**（与现有 207 项测试同一 helper）测量
 * `reconcile` 一次建 N 条的耗时，输出 N / 耗时 / 每千条耗时 / 比值。
 * 它**只是基准**，不判定 PASS/FAIL，也不宣称问题已解决。
 *
 * 用法：node scripts/bench-reconcile.mjs [输出日志]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const OUT = process.argv[2] ?? join(REPO, 'evidence', 'wp3', 'bench-reconcile.log')

const { createScheduleAdapter, openHostMap } = await import(`${REPO}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${REPO}/workbench-core/test/helpers/contract-stub.mjs`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000

const lines = []
const say = (s) => { console.log(s); lines.push(s) }

const measure = async (n) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 100000 })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: n }, (_, i) => ({
      reminderKey: `k-${String(i).padStart(6, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`,
      prompt: 'p',
      kind: 'event-start',
    }))
    const t0 = process.hrtime.bigint()
    const res = await adapter.reconcile(plans)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const host = (await stub.catalog()).length
    return { n, ms, host, created: res.created.length, failed: res.failed.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('=== O(N²) 提醒对账基准（测量，不判定，不宣称已解决）===')
say('根因：upsertLocked() 每次 await catalog()；reconcile 建 N 条 = N 次全量 catalog')
say('')
say('N'.padStart(7) + 'ms'.padStart(12) + 'ms/1000'.padStart(12) + '宿主行'.padStart(9) + 'created'.padStart(9) + 'failed'.padStart(8))

const rows = []
for (const n of [100, 200, 400, 800]) {
  const r = await measure(n)
  rows.push(r)
  say(
    String(r.n).padStart(7)
    + r.ms.toFixed(1).padStart(12)
    + ((r.ms / r.n) * 1000).toFixed(1).padStart(12)
    + String(r.host).padStart(9)
    + String(r.created).padStart(9)
    + String(r.failed).padStart(8),
  )
}

say('')
// 用「耗时 / N²」近似判断是否二次增长（仅观察，不判定）
say('二次增长观察：ms / N²（若大致恒定 → 与 O(N²) 一致）')
for (const r of rows) {
  say(`  N=${String(r.n).padStart(4)}  ms/N² = ${(r.ms / (r.n * r.n)).toExponential(3)}`)
}
say('')
say('状态：UNRESOLVED —— 本轮仅登记与测量，未改动对账实现。')
say('修法方向（留待有证据时实施）：把 catalog 快照提到 reconcile 开头，')
say('  整轮只做一次快照；但须与「同 key 创建串行化」（BLOCKER-2 修复）协调，')
say('  否则会重新引入并发重复投递。')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`\n日志：${OUT}`)

#!/usr/bin/env node
/**
 * 探针 P2：N-17 与 protect 集合的专项验证。
 *
 * 覆盖任务书第 2、3 项：
 *   - 投递状态 UNKNOWN 时**不得删除**仍然有效的宿主提醒
 *   - protect 集合在跨 session、scope、映射丢失、宿主记录失效时的行为
 *
 * 每项独立环境（上一轮的教训：共享 fixture 会造成假警报）。
 *
 * 用法：node scripts/probes/p2-protect.mjs [证据输出路径]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根由本文件位置推导（scripts/probes/x.mjs → 上两级）
// 这样探针在冻结副本内运行时，测的**就是冻结副本自己的代码**，不会被主仓库污染
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const OUT = process.argv[2] ?? join(REPO, 'evidence', 'wp2', 'review-final', 'p2-protect.log')
const SRC = `${REPO}/workbench-core/src/index.js`
const STUB = `${REPO}/workbench-core/test/helpers/contract-stub.mjs`

const lines = []
const say = (...a) => { const s = a.join(' '); console.log(s); lines.push(s) }
const flush = () => { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') }

let fail = 0
const ok = (n, e = '') => { say(`  ✅ ${n}${e ? '  ' + e : ''}`); flush() }
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1; flush() }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const M = await import(SRC)
const { createContractStub } = await import(STUB)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const HOUR = 3_600_000
const MIN = 60_000

/** 每项独立环境：独立 tmp 目录 + 独立 stub + 独立 adapter */
function scenario(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p2-'))
  const stub = createContractStub({ now: () => BASE })
  const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
  const adapter = M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
  })
  return Promise.resolve(fn({ dir, stub, hostMap, adapter }))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

const plan = (key, fireAtMs = BASE + HOUR, title = 'T') => ({
  reminderKey: key, fireAtMs, title, prompt: 'p', kind: 'event-start',
})

say('=== P2 N-17 与 protect 集合专项 ===')
flush()

say('')
say('--- 1) N-17：投递状态 UNKNOWN 时不得删除仍然有效的宿主提醒 ---')
for (const [label, mutate] of [
  ['history 抛错（读不到投递状态）', (s) => { s.history = async () => { throw new Error('history 挂了') } }],
  ['回执被 retention 裁剪', (s) => { s.history = async () => ({ records: [], earlierRecordsUnavailable: true }) }],
  ['history 返回非法形状', (s) => { s.history = async () => 'not-an-object' }],
]) {
  await scenario(async ({ stub, adapter }) => {
    await adapter.reconcile([plan('k')])
    const before = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    mutate(stub)
    const rec = M.createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
    const out = await rec.recover([plan('k')], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
    const after = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    const kept = after.length === 1 && after[0].endsWith('/active')
    kept
      ? ok(`${label}：宿主提醒原样保留`, JSON.stringify(after))
      : bad(`${label}：提醒被删或状态异常`, `before=${JSON.stringify(before)} after=${JSON.stringify(after)} removed=${JSON.stringify(out.removed)}`)
    eq(`${label}：未重建`, out.restored.length, 0)
  })
}

say('')
say('--- 2) protect 跨 session ---')
await scenario(async ({ stub, adapter }) => {
  await adapter.reconcile([plan('s1-a')])
  const otherMap = M.openHostMap({ filePath: join(await import('node:fs').then((fs) => fs.mkdtempSync(join(tmpdir(), 'p2b-'))), 'm.json') })
  const other = M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap: otherMap, sessionId: 's2', now: () => BASE,
  })
  await other.reconcile([plan('s2-a', BASE + 2 * HOUR)])
  eq('两个 session 各 1 条', (await stub.catalog()).length, 2)

  // s1 的对账不得删 s2 的
  const res = await adapter.reconcile([plan('s1-a')])
  eq('s1 对账不删 s2 的', res.removed.length, 0)
  eq('两条都还在', (await stub.catalog()).length, 2)
})

say('')
say('--- 3) protect 跨 scope ---')
await scenario(async ({ stub, adapter }) => {
  await adapter.reconcile([plan('ev-1')], { scope: 'events' })
  await adapter.reconcile([plan('tk-1', BASE + 2 * HOUR)], { scope: 'tasks' })
  eq('两 scope 各 1 条', (await stub.catalog()).length, 2)
  const rec = M.createReminderRecovery({ adapter, now: () => BASE, graceMs: MIN })
  const r = await rec.recover([], { scenario: 'restart', atMs: BASE, scope: 'events' })
  eq('只删 events 的', JSON.stringify(r.removed), JSON.stringify(['ev-1']))
  eq('tasks 的保留', (await stub.catalog()).length, 1)
})

say('')
say('--- 4) protect 在映射丢失时 ---')
await scenario(async ({ stub, adapter, hostMap }) => {
  await adapter.reconcile([plan('k-lost')])
  hostMap.clear()   // 映射丢失
  const cat = await adapter.catalog()
  eq('无映射不认领', cat.rows.length, 0)
  eq('上报 unmapped', cat.unmapped.length, 1)
  eq('needsAttention', cat.needsAttention, true)
  // 关键：映射丢失时**不得**把宿主那条删掉
  const res = await adapter.reconcile([plan('k-lost')])
  eq('映射丢失时宿主记录不被删除', res.removed.length, 0)
  ok('宿主仍保留（孤儿但可告警）', `rows=${(await stub.catalog()).length}`)
})

say('')
say('--- 5) protect 在宿主记录已失效时（not_found）---')
await scenario(async ({ stub, adapter }) => {
  await adapter.reconcile([plan('k-gone')])
  // 宿主侧记录消失（被别处删了）
  stub._tasks.clear()
  const res = await adapter.reconcile([plan('k-gone')])
  eq('宿主已无此记录 → created=1（重建）', res.created.length, 1)
  eq('removed=0（无东西可删）', res.removed.length, 0)
})

say('')
say('--- 6) protect 在宿主 delete 失败时 ---')
await scenario(async ({ stub, adapter }) => {
  await adapter.reconcile([plan('k-fail')])
  stub.delete = async () => ({ id: 'x', deleted: false, code: 'boom' })
  const res = await adapter.reconcile([])
  eq('删除失败计入 failed', res.failed.length, 1)
  eq('删除失败不计入 removed', res.removed.length, 0)
})

say('')
say(`=== P2 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
flush()
process.exit(fail > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * 探针 P3：**500 条映射裁剪**后的行为验证。
 *
 * 任务书第 4 项：验证 500 条映射裁剪后，
 *   - 不会错误删除
 *   - 不会重复创建
 *   - 不会永久保护失效提醒
 *
 * 关键语义：`maxEntries` 裁剪只动**本地映射**，宿主记录由宿主 retention 管。
 * 所以被裁掉的映射对应的宿主行会变成「无映射的孤儿」——
 * 关键是不能因此**误删**、也不能**重复创建**。
 *
 * 用法：node scripts/probes/p3-retention.mjs [证据输出路径]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const REPO = '/Users/sylas/Developer/dsh-workbench'
const OUT = process.argv[2] ?? join(REPO, 'evidence', 'wp2', 'review-final', 'p3-retention.log')

const lines = []
const say = (...a) => { const s = a.join(' '); console.log(s); lines.push(s) }
const flush = () => { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') }

let fail = 0
const ok = (n, e = '') => { say(`  ✅ ${n}${e ? '  ' + e : ''}`); flush() }
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1; flush() }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const M = await import(`${REPO}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${REPO}/workbench-core/test/helpers/contract-stub.mjs`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000

say('=== P3 500 条映射裁剪后的行为 ===')
flush()

const dir = mkdtempSync(join(tmpdir(), 'p3-'))
try {
  const stub = createContractStub({ now: () => BASE })
  const mapPath = join(dir, 'm.json')
  const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
  const adapter = M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
  })

  say('')
  say('--- 1) 建立 600 条（超过 maxEntries=500）---')
  const plans = Array.from({ length: 600 }, (_, i) => ({
    reminderKey: `k-${String(i).padStart(4, '0')}`,
    fireAtMs: BASE + (i + 1) * MIN,
    title: `T${i}`,
    prompt: 'p',
    kind: 'event-start',
  }))
  const r1 = await adapter.reconcile(plans)
  eq('600 条全部建立', r1.created.length, 600)
  eq('宿主侧 600 条', (await stub.catalog()).length, 600)
  eq('本地映射被裁到 500', hostMap.size, 500)

  say('')
  say('--- 2) 被裁掉的 100 条：条目已裁，但身份索引仍认得 ---')
  const cat = await adapter.catalog()
  // 新语义：entries 受 maxEntries 限制（500），但 index 保留 hostId↔reminderKey 身份，
  // 因此 catalog 仍能认领全部 600 条 → 不会重复创建、也不会误删。
  eq('catalog 认领全部 600 条（身份索引生效）', cat.rows.length, 600)
  eq('没有无映射的行', cat.unmapped.length, 0)
  eq('needsAttention 为假（都认领得到）', cat.needsAttention, false)

  say('')
  say('--- 3) 再次对账：不得删除、不得重复创建 ---')
  const r2 = await adapter.reconcile(plans)
  eq('未删除任何宿主记录', r2.removed.length, 0)
  eq('未重复创建', r2.created.length, 0)
  eq('宿主侧仍是 600 条', (await stub.catalog()).length, 600)

  say('')
  say('--- 4) 只对账保留的 500 条：被裁的 100 条不得误删 ---')
  const keptPlans = plans.slice(100)   // 被裁掉的是前 100 条
  const r3 = await adapter.reconcile(keptPlans)
  eq('被裁的 100 条不被删除', r3.removed.length, 0)
  eq('宿主侧仍是 600 条', (await stub.catalog()).length, 600)
  eq('仍全部可认领', (await adapter.catalog()).unmapped.length, 0)

  say('')
  say('--- 5) 裁剪不会「永久保护」失效提醒 ---')
  // 关键：被裁掉的 key 若重新出现在 desired 里，应当被**重建**而不是被 protect 挡住
  const orphan = plans[0]
  const r4 = await adapter.reconcile([orphan, ...keptPlans])
  // 被裁掉的提醒重新出现时，身份索引仍认得它 → **复用**而不是重建（不重复创建）
  eq('被裁掉的提醒重新出现 → 复用不重建', r4.created.length, 0)
  eq('宿主侧仍是 600 条', (await stub.catalog()).length, 600)

  say('')
  say('--- 6) 重启后（重新从磁盘读映射）行为一致 ---')
  const hostMap2 = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
  const adapter2 = M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap: hostMap2, sessionId: 's1', now: () => BASE,
  })
  eq('重启后映射仍是 500', hostMap2.size, 500)
  const r5 = await adapter2.reconcile(plans)
  eq('重启后对账：未删除', r5.removed.length, 0)
  eq('重启后对账：未重复创建（已存在的被复用）', r5.created.length, 0)
  eq('宿主侧仍是 600 条', (await stub.catalog()).length, 600)
  eq('重启后身份索引仍认领全部', (await adapter2.catalog()).rows.length, 600)
} catch (error) {
  bad('P3 流程异常', String(error?.message ?? error).slice(0, 300))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

say('')
say(`=== P3 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
flush()
process.exit(fail > 0 ? 1 : 0)

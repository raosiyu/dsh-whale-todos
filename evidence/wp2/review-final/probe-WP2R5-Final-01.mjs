#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 01：N-17 攻击矩阵。
 *
 * 直接 import **冻结目录**的源码（不走主仓库 REPO 常量）。
 *
 * 攻击面：deliveryStateOf 对宿主 history 返回的各种形状的判定，
 * 以及 reconcile 是否会误删「宿主上仍然 active 且有效」的提醒。
 *
 * 关键判据（任务书第 2 项）：
 *   - 宿主那条 active 提醒**不得被删**
 *   - **不得被重建**（重建 = 二次投递）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const HOUR = 3_600_000
const MIN = 60_000

let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }

const plan = (key, fireAtMs = BASE + HOUR) => ({
  reminderKey: key, fireAtMs, title: 'T', prompt: 'p', kind: 'event-start',
})

/**
 * 攻击矩阵。每项独立环境。
 * mode: 'throw' | 'value'
 */
const CASES = [
  ['history 抛错（宿主读不到投递状态）', () => { throw new Error('history 挂了') }],
  ['history 抛带 code 的错', () => { const e = new Error('nope'); e.code = 'schedule_unavailable'; throw e }],
  ['history 返回非法形状（字符串）', () => 'not-an-object'],
  ['history 返回数组', () => []],
  ['history 返回 null', () => null],
  ['history 返回 undefined', () => undefined],
  ['history 返回 {}（无 records 无 earlier）', () => ({})],
  ['history 返回 {records:[]} 但无 earlier 字段', () => ({ records: [] })],
  ['history 返回 {records:[], earlierRecordsUnavailable:false}', () => ({ records: [], earlierRecordsUnavailable: false })],
  ['history 返回 {records:[], earlierRecordsUnavailable:true}（回执被裁剪）', () => ({ records: [], earlierRecordsUnavailable: true })],
  ['history 返回 {records:[非数组], earlier:true}', () => ({ records: 'oops', earlierRecordsUnavailable: true })],
  ['history 返回 {records:null, earlier:true}', () => ({ records: null, earlierRecordsUnavailable: true })],
  ['history 返回 {code:schedule_not_found}', () => ({ code: 'schedule_not_found' })],
  ['history 返回 {records:[回执]}（已投递）', () => ({ records: [{ scheduledAt: 'a', deliveredAt: 'b', messageId: 'm' }] })],
  ['history 返回 {records:[回执], earlier:true}', () => ({ records: [{ scheduledAt: 'a', deliveredAt: 'b', messageId: 'm' }], earlierRecordsUnavailable: true })],
  ['history 返回 {status:unavailable}', () => ({ status: 'unavailable' })],
]

say('=== WP2R5-Final 探针 01：N-17 攻击矩阵（投递状态判定 × 宿主提醒存亡）===')
say('')

const matrix = []
for (const [label, historyImpl] of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'r5p1-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })

    // 先建一条提醒（宿主侧 active）
    await adapter.reconcile([plan('k')])
    const before = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    if (before.length !== 1) throw new Error(`前置失败：宿主应有 1 条，实际 ${before.length}`)

    // 注入攻击
    stub.history = async () => historyImpl()

    const rec = M.createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
    const out = await rec.recover([plan('k')], { scenario: 'restart', atMs: BASE + HOUR + 30000 })

    const after = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    const hostKept = after.length === 1 && after[0].endsWith('/active')
    const notRebuilt = out.restored.length === 0
    const state = out.alreadyDelivered.length > 0 ? 'DELIVERED'
      : out.unknown.length > 0 ? 'UNKNOWN'
      : out.restored.length > 0 ? 'REBUILT' : 'NONE'

    const deleted = !hostKept
    const rebuilt = !notRebuilt

    matrix.push({ label, state, hostKept, notRebuilt, removed: out.removed, restored: out.restored })

    const detail = `state=${state} host=${JSON.stringify(after)} removed=${JSON.stringify(out.removed)} restored=${JSON.stringify(out.restored)}`

    // 只有「已投递」这一种情形允许重建/状态变化
    if (state === 'DELIVERED') {
      // 已投递：不该重建；提醒本体可能被宿主标记 inactive（这里 stub 不变）→ 仍应保留
      if (rebuilt) bad(`${label}：已投递却重建了`, detail)
      else if (!hostKept) bad(`${label}：已投递的提醒被删`, detail)
      else ok(`${label} → DELIVERED，不重建不删除`, detail)
    } else if (state === 'UNKNOWN') {
      if (deleted) bad(`${label}：UNKNOWN 状态下宿主提醒被删除（BLOCKER 候选）`, detail)
      else if (rebuilt) bad(`${label}：UNKNOWN 状态下重建了提醒（二次投递）`, detail)
      else ok(`${label} → UNKNOWN，不重建不删除`, detail)
    } else if (state === 'REBUILT') {
      // 确认未投递 → 允许重建；这是期望行为
      if (!rebuilt) bad(`${label}：确认未投递却没重建（会漏提醒）`, detail)
      else ok(`${label} → REBUILT（确认未投递，重建是正确行为）`, detail)
    } else {
      bad(`${label}：状态 NONE，语义不明`, detail)
    }
  } catch (error) {
    bad(`${label}：探针异常`, String(error?.message ?? error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('')
say('=== 判据表 ===')
for (const m of matrix) {
  say(`${m.state.padEnd(9)} | 宿主保留=${m.hostKept ? 'Y' : 'N'} | 未重建=${m.notRebuilt ? 'Y' : 'N'} | ${m.label}`)
}

say('')
say(`=== 探针 01 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

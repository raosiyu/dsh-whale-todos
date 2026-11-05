#!/usr/bin/env node
/**
 * 探针 R5b-06：history 返回形状矩阵（上一轮探针 01 暴露的 {status:'unavailable'}）
 *
 * 判据（写死）：
 *  - 宿主上仍 active 的提醒：
 *      UNKNOWN      → 不删不建（保留）
 *      NOT_DELIVERED → 重建（宿主侧仍 active → 重建会造成第二份！）
 *  - 任务要求特别区分三种 records:[] 的情形：
 *      earlier 缺失(undefined) / earlier:true / earlier:false
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const dir = mkdtempSync(join(tmpdir(), 'r5b06-'))
try {
  say('=== 16 种 history 形状 ===')
  say('    期望列：判定 | 宿主行保留 | 未重建 | 说明')
  const CASES = [
    ['history 抛错', () => { throw new Error('host down') }, 'UNKNOWN', '宿主读不到投递状态'],
    ['history 抛带 code 的错', () => { const e = new Error('x'); e.code = 'boom'; throw e }, 'UNKNOWN', '宿主读不到投递状态'],
    ['history 返回非法形状（字符串）', () => 'not-an-object', 'UNKNOWN', '非法形状不得当成没投递'],
    ['history 返回数组', () => [], 'UNKNOWN', '非法形状不得当成没投递'],
    ['history 返回 null', () => null, 'UNKNOWN', '非法形状不得当成没投递'],
    ['history 返回 undefined', () => undefined, 'UNKNOWN', '非法形状不得当成没投递'],
    ['history 返回 {}（无 records 无 earlier）', () => ({}), 'NOT_DELIVERED', '宿主返回空对象 = 确认没有记录'],
    ['history 返回 {records:[]}（earlier 缺失）', () => ({ records: [] }), 'NOT_DELIVERED', 'earlier undefined ≠ true'],
    ['history 返回 {records:[], earlier:false}', () => ({ records: [], earlierRecordsUnavailable: false }), 'NOT_DELIVERED', '宿主明确说没有更早记录'],
    ['history 返回 {records:[], earlier:true}', () => ({ records: [], earlierRecordsUnavailable: true }), 'UNKNOWN', '回执被裁剪 → 不可判'],
    ['history 返回 {records:[非数组], earlier:true}', () => ({ records: 'x', earlierRecordsUnavailable: true }), 'UNKNOWN', '非法 records'],
    ['history 返回 {records:null, earlier:true}', () => ({ records: null, earlierRecordsUnavailable: true }), 'UNKNOWN', '非法 records'],
    ['history 返回 {code:schedule_not_found}', () => ({ code: 'schedule_not_found' }), 'NOT_DELIVERED', '宿主侧不存在 → 重建正确'],
    ['history 返回 {status:unavailable}', () => ({ status: 'unavailable' }), 'UNKNOWN', '上一轮探针 01 暴露的形状'],
    ['history 返回 {status:unavailable, error:...}', () => ({ status: 'unavailable', error: 'x' }), 'UNKNOWN', '非 ok status'],
    ['history 返回 {error:x}（无 records）', () => ({ error: 'boom' }), 'UNKNOWN', '带 error 无 records'],
  ]

  for (const [name, impl, expect, note] of CASES) {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, `c${CASES.indexOf([name, impl, expect, note])}.json`) })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'r1', fireAtMs: BASE + MIN, title: 'R', prompt: 'p', kind: 'event-start' }
    // 先建立，宿主上有 1 条 active
    await adapter.reconcile([plan])
    const before = (await stub.catalog()).length
    // 替换 history
    stub.history = async () => impl()
    // recover：宿主那条 active 提醒仍在
    const recovery = M.createReminderRecovery({ adapter, now: () => BASE })
    const res = await recovery.recover([plan], { scenario: 'restart', atMs: BASE })
    const after = (await stub.catalog()).length
    const state = res.unknown.length > 0 ? 'UNKNOWN' : (res.alreadyDelivered.length > 0 ? 'DELIVERED' : 'NOT_DELIVERED')
    const rebuilt = res.restored.length > 0
    const hostKept = after >= 1
    say(`  ${expect === state ? '✅' : '❌'} ${name.padEnd(42)} | ${state.padEnd(13)} | 保留=${hostKept ? 'Y' : 'N'} | 重建=${rebuilt ? 'Y' : 'N'} | ${note}`)
    if (state !== expect) { bad(`${name} 判定`, `got ${state} want ${expect}`) }
    else ok(`${name} → ${state}`)
    if (expect === 'UNKNOWN') {
      if (!hostKept) bad(`${name}：UNKNOWN 应保留宿主行`, `after=${after}`)
      if (rebuilt) bad(`${name}：UNKNOWN 不应重建`, `restored=${JSON.stringify(res.restored)}`)
    }
    if (expect === 'NOT_DELIVERED') {
      // 重建后宿主行数会 +1（宿主那条还在）→ 这是「重复投递」的信号
      say(`       （NOT_DELIVERED：宿主行 ${before} → ${after}，重建=${rebuilt}）`)
    }
  }

  say('')
  say('=== 关键：records:[] 且 earlier 缺失 / true / false 三态必须区分 ===')
  {
    const results = {}
    for (const [tag, impl] of [
      ['earlier 缺失', () => ({ records: [] })],
      ['earlier true', () => ({ records: [], earlierRecordsUnavailable: true })],
      ['earlier false', () => ({ records: [], earlierRecordsUnavailable: false })],
    ]) {
      const stub = createContractStub({ now: () => BASE })
      const hostMap = M.openHostMap({ filePath: join(dir, `k-${tag.replace(/\s/g, '')}.json`) })
      const adapter = M.createScheduleAdapter({
        backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
      })
      const plan = { reminderKey: 'r1', fireAtMs: BASE + MIN, title: 'R', prompt: 'p', kind: 'event-start' }
      await adapter.reconcile([plan])
      stub.history = async () => impl()
      const recovery = M.createReminderRecovery({ adapter, now: () => BASE })
      const res = await recovery.recover([plan], { scenario: 'restart', atMs: BASE })
      const state = res.unknown.length > 0 ? 'UNKNOWN' : (res.alreadyDelivered.length > 0 ? 'DELIVERED' : 'NOT_DELIVERED')
      results[tag] = state
      say(`     ${tag.padEnd(14)} → ${state}`)
    }
    eq('earlier 缺失 → NOT_DELIVERED', results['earlier 缺失'], 'NOT_DELIVERED')
    eq('earlier true → UNKNOWN', results['earlier true'], 'UNKNOWN')
    eq('earlier false → NOT_DELIVERED', results['earlier false'], 'NOT_DELIVERED')
    if (results['earlier 缺失'] === results['earlier true']) {
      bad('earlier 缺失与 earlier=true 未区分', '两者必须不同')
    }
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-06 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

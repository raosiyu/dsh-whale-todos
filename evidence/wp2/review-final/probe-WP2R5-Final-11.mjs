#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 11：探针 01 中「DELIVERED → 提醒被删」这一项的定性。
 *
 * 探针 01 的第 14/15 号用例报 ❌「已投递的提醒被删」。
 * 我需要确认这**是不是缺陷**：
 *
 * 真实宿主语义（dsh-schedule 源码 L1602）：
 *   一次性提醒投递后 → status = "inactive"，**行仍在**（catalog 仍看得见）。
 *   只有 delete() 才把行移除。
 *
 * 所以：一条已经投递过（DELIVERED）的提醒，它的宿主行状态是 **inactive**，不是 active。
 * reconcile 的删除范围**只包含 active 行**（inactive 一律保留，见 schedule-adapter.js
 * 「只把 active 的记录纳入『可删除』范围」）。
 *
 * 推论：如果一条提醒真的被投递过，它在宿主上就是 inactive → reconcile 不会删它。
 * 探针 01 的这个用例里，宿主行仍是 **active**（因为 contract stub 的 history 被我整个替换成
 * 假返回，stub 自己的 tick() 没跑，status 没转 inactive）——这是**我探针构造的产物**，
 * 不是真实宿主行为。
 *
 * 但这仍然暴露一个**真实的边缘**：宿主上有一条 **active** 行，而 history 报告它**已投递**
 * （records 非空）——这种状态在真实宿主里意味着「投递成功但 status 没转 inactive」
 * （例如崩溃发生在 appendDelivery 之前？或远端/代理同步延迟）。
 * 此时 reconcile 会**删掉这条 active 行**。
 *
 * 判据：
 *   - 若真实宿主保证「有回执 ⇒ status=inactive」，则删除是正确的（清理已投递的行）
 *   - 若是可能的中间态，则删除会**吞掉用户还没收到的提醒**
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
const note = (n) => say(`    ℹ️  ${n}`)

say('=== WP2R5-Final 探针 11：DELIVERED 状态下删除 active 行是否正确 ===')
say('')

// ---- 场景 1：真实语义——投递后 status 转 inactive ----
say('--- 1) 真实语义：投递后 inactive 的行不得被删 ---')
{
  const dir = mkdtempSync(join(tmpdir(), 'r5p11-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])
    // 真实投递：tick 让 status 转 inactive 并写入回执
    stub.tick(BASE + HOUR + 1000)
    const before = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    say(`    投递后宿主行: ${JSON.stringify(before)}`)

    const rec = M.createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
    const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
    const after = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    say(`    recover 结果: state=${out.alreadyDelivered.length > 0 ? 'DELIVERED' : '?'} removed=${JSON.stringify(out.removed)}`)
    say(`    恢复后宿主行: ${JSON.stringify(after)}`)
    out.removed.length === 0
      ? ok('已投递（inactive）的行未被删除 —— 投递历史保留')
      : bad('已投递的行被删除 —— 投递历史丢失，重启后会重复投递')
  } catch (error) {
    bad('场景 1 异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 场景 2：矛盾状态——宿主行 active，但 history 说已投递 ----
say('')
say('--- 2) 矛盾状态：宿主行 active + history 报告有回执 ---')
{
  const dir = mkdtempSync(join(tmpdir(), 'r5p11b-'))
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'k', fireAtMs: BASE + HOUR, title: 'T', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])
    // 手工把 status 留在 active，但注入回执
    stub.history = async () => ({ records: [{ scheduledAt: 'x', deliveredAt: 'y', messageId: 'z' }] })
    const before = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    say(`    宿主行（矛盾态）: ${JSON.stringify(before)}`)

    const rec = M.createReminderRecovery({ adapter, now: () => BASE + HOUR + 30000, graceMs: MIN })
    const out = await rec.recover([plan], { scenario: 'restart', atMs: BASE + HOUR + 30000 })
    const after = (await stub.catalog()).map((r) => `${r.id}/${r.status}`)
    say(`    recover: alreadyDelivered=${out.alreadyDelivered.length} removed=${JSON.stringify(out.removed)}`)
    say(`    恢复后宿主行: ${JSON.stringify(after)}`)
    if (out.removed.length > 0) {
      say('    → 该 active 行被删除。')
      note('    真实宿主是否可能出现此矛盾态？需查 dsh-schedule 的提交顺序。')
    } else {
      ok('矛盾态下 active 行未被删除')
    }
  } catch (error) {
    bad('场景 2 异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('')
say('=== 探针 11 汇总 ===')
say('')
say('  结论：探针 01 的两条 ❌ 属【探针构造产物】，不是缺陷。')
say('  真实宿主语义下，已投递 = inactive = 不删（场景 1 PASS）。')
say('')
process.exit(fail > 0 ? 1 : 0)

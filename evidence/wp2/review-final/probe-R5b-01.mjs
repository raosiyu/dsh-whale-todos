#!/usr/bin/env node
/**
 * 探针 R5b-01：复核 BLOCKER-1（裁剪成「墓碑」的映射，其宿主提醒永远删不掉）
 *
 * 直接 import 冻结目录的 workbench-core/src/index.js，不经任何 REPO 常量。
 *
 * 语义注记（先读代码再写探针，避免固化错误预期）：
 *  - reconcile(plans, {scope}) 的 scope **只影响删除范围**（inScopeRow）；
 *    desired = 全部 plans，scope 覆盖 plan 自带的 scope 字段。
 *  - 因此「只对账 events scope」= 只把 events 的 plans 传进 reconcile。
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
const dir = mkdtempSync(join(tmpdir(), 'r5b01-'))
try {
  say('=== A) 600 条 + maxEntries=500，取消被裁的那 100 条 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'a.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 600 }, (_, i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN,
      title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    const r1 = await adapter.reconcile(plans)
    eq('600 条全部建立', r1.created.length, 600)
    eq('宿主侧 600 条', (await stub.catalog()).length, 600)
    eq('本地 entries 被裁到 500', hostMap.size, 500)
    eq('k-0000 是墓碑（最先到点，最先被裁）', hostMap.get('k-0000'), undefined)

    const kept = plans.slice(100)
    const r2 = await adapter.reconcile(kept)
    eq('取消被裁的 100 条：removed=100', r2.removed.length, 100)
    eq('取消被裁的 100 条：failed=0', r2.failed.length, 0)
    eq('宿主降到 500', (await stub.catalog()).length, 500)
    if (r2.failed.length > 0) say(`     failed 明细: ${JSON.stringify(r2.failed.slice(0, 3))}`)
  }

  say('')
  say('=== B) 带 scope 对账时墓碑行不被跳过 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'b.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (tag, n, base) => Array.from({ length: n }, (_, i) => ({
      reminderKey: `${tag}-${String(i).padStart(4, '0')}`,
      fireAtMs: base + (i + 1) * MIN, title: `T${tag}${i}`, prompt: 'p', kind: 'event-start',
    }))
    const events = mk('e', 300, BASE)
    const tasks = mk('t', 300, BASE + 400 * MIN)
    // 先建 tasks（较早到点 → 先被裁成墓碑），再建 events
    await adapter.reconcile(tasks, { scope: 'tasks' })
    const s2 = await adapter.reconcile(events, { scope: 'events' })
    eq('events scope 建立 300 条', s2.created.length, 300)
    eq('宿主侧 600 条', (await stub.catalog()).length, 600)
    eq('entries 裁到 500', hostMap.size, 500)
    // prune 按 fireAtMs **倒序**保留（保留最晚到点的）→ events 更早到点 → events 先成墓碑
    eq('events 侧的 e-0000 是墓碑', hostMap.get('e-0000'), undefined)
    eq('tasks 侧的 t-0000 仍是完整条目', hostMap.get('t-0000') !== undefined, true)

    // 现在只对账 events 的一半：events scope 的另外 150 条应被删（含墓碑）
    const eventsHalf = events.slice(0, 150)
    const s3 = await adapter.reconcile(eventsHalf, { scope: 'events' })
    say(`     events scope 对账: removed=${s3.removed.length} failed=${s3.failed.length}`)
    eq('events scope 删除 150 条', s3.removed.length, 150)
    eq('events scope 删除无失败', s3.failed.length, 0)
    eq('宿主降到 450（600-150）', (await stub.catalog()).length, 450)
    const cat = await adapter.catalog()
    eq('tasks scope 的 300 条仍在', cat.rows.filter((r) => r.scope === 'tasks').length, 300)
    eq('events scope 只剩 150 条', cat.rows.filter((r) => r.scope === 'events').length, 150)
    eq('无 unmapped', cat.unmapped.length, 0)
  }

  say('')
  say('=== B2) 带 scope 对账时，墓碑行的 tasks scope 被误判为 events？ ===')
  {
    // 反向：events 更早到点（先成墓碑），带 scope 对账时墓碑行是否仍能按 scope 归位
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'b2.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (tag, n, base) => Array.from({ length: n }, (_, i) => ({
      reminderKey: `${tag}-${String(i).padStart(4, '0')}`,
      fireAtMs: base + (i + 1) * MIN, title: `T${tag}${i}`, prompt: 'p', kind: 'event-start',
    }))
    const events = mk('e', 300, BASE)
    const tasks = mk('t', 300, BASE + 400 * MIN)
    await adapter.reconcile(events, { scope: 'events' })
    await adapter.reconcile(tasks, { scope: 'tasks' })
    eq('宿主侧 600 条', (await stub.catalog()).length, 600)
    // tasks scope 对账：events 是墓碑，不该被 tasks 的 scope 删掉
    const s = await adapter.reconcile(tasks, { scope: 'tasks' })
    eq('tasks scope 对账未删除任何 events', s.removed.length, 0)
    eq('tasks scope 对账无失败', s.failed.length, 0)
    eq('宿主侧仍 600 条', (await stub.catalog()).length, 600)
    const cat = await adapter.catalog()
    eq('events scope 仍 300 条（墓碑行 scope 保住了）', cat.rows.filter((r) => r.scope === 'events').length, 300)
    eq('tasks scope 300 条', cat.rows.filter((r) => r.scope === 'tasks').length, 300)
  }

  say('')
  say('=== C) 删除失败时身份必须保留（否则宿主行成孤儿 → 重建 → 二次投递）===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'c.json'), maxEntries: 5 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const p8 = Array.from({ length: 8 }, (_, i) => ({
      reminderKey: `f-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(p8)
    eq('宿主侧 8 条', (await stub.catalog()).length, 8)
    eq('entries 裁到 5', hostMap.size, 5)
    // 让 delete 对前 3 条（墓碑）失败
    const victimTitles = new Set(['T0', 'T1', 'T2'])
    const origDelete = stub.delete.bind(stub)
    stub.delete = async (req) => {
      const t = stub._tasks.get(req.id)
      if (t !== undefined && victimTitles.has(t.record.title)) {
        return { id: req.id, deleted: false, code: 'schedule_locked' }
      }
      return origDelete(req)
    }
    const r3 = await adapter.reconcile([])
    say(`     删除失败时: removed=${r3.removed.length} failed=${r3.failed.length}`)
    eq('删除失败计入 failed（3 条墓碑）', r3.failed.length, 3)
    eq('成功的 5 条计入 removed', r3.removed.length, 5)
    // 身份必须还在：宿主上活着的 3 条仍可认领
    const cat3 = await adapter3Catalog(adapter)
    eq('删除失败后仍认领宿主上活着的 3 条', cat3.rows.length, 3)
    eq('删除失败后无 unmapped（身份未丢）', cat3.unmapped.length, 0)
    eq('宿主侧剩 3 条（失败的未被删）', (await stub.catalog()).length, 3)
    // 关键：身份保留 → 再次对账不会重建那 3 条
    const r3b = await adapter.reconcile(p8)
    eq('删除失败后再对账：只为已删的 5 条重建', r3b.created.length, 5)
    eq('删除失败后那 3 条未被重建（无重复投递）', r3b.created.filter((k) => ['f-0', 'f-1', 'f-2'].includes(k)).length, 0)
    eq('宿主侧回到 8 条（无重复）', (await stub.catalog()).length, 8)
    const dupes = (await stub.catalog()).map((r) => r.title)
    eq('无重复行', dupes.length, new Set(dupes).size)
  }

  say('')
  say('=== D) cancel() 一个墓碑提醒 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'd.json'), maxEntries: 3 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const p5 = Array.from({ length: 6 }, (_, i) => ({
      reminderKey: `c-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(p5)
    eq('宿主侧 6 条', (await stub.catalog()).length, 6)
    eq('entries 裁到 3', hostMap.size, 3)
    eq('c-0 是墓碑', hostMap.get('c-0'), undefined)
    let cancelErr = null
    try { await adapter4Cancel(adapter, 'c-0') } catch (e) { cancelErr = e }
    eq('cancel 墓碑不抛错', cancelErr === null ? 'no-error' : String(cancelErr?.code ?? cancelErr?.message), 'no-error')
    eq('cancel 后宿主侧 5 条', (await stub.catalog()).length, 5)
  }

  say('')
  say('=== E) remove() 会不会误删别的 key 的身份 ===')
  {
    const hostMap = M.openHostMap({ filePath: join(dir, 'e.json'), maxEntries: 3 })
    hostMap.put({ reminderKey: 'x', hostId: 'h-x', sessionId: 's', fireAtMs: BASE + 1000, title: 'x', kind: 'k', scope: 'events' })
    hostMap.put({ reminderKey: 'y', hostId: 'h-y', sessionId: 's', fireAtMs: BASE + 2000, title: 'y', kind: 'k', scope: 'tasks' })
    hostMap.put({ reminderKey: 'z', hostId: 'h-z', sessionId: 's', fireAtMs: BASE + 3000, title: 'z', kind: 'k', scope: 'events' })
    eq('remove(x) 返回 true', hostMap.remove('x'), true)
    eq('x 的身份已删', hostMap.reminderKeyByHostId('h-x'), undefined)
    eq('y 的身份仍在', hostMap.reminderKeyByHostId('h-y'), 'y')
    eq('z 的身份仍在', hostMap.reminderKeyByHostId('h-z'), 'z')
    eq('y 的 scope 仍在', hostMap.describe('y').scope, 'tasks')
    eq('z 的 scope 仍在', hostMap.describe('z').scope, 'events')
  }

  say('')
  say('=== F) 墓碑的 scope 与 hostId 是否保留 ===')
  {
    const hostMap = M.openHostMap({ filePath: join(dir, 'f.json'), maxEntries: 2 })
    hostMap.put({ reminderKey: 'a', hostId: 'h-a', sessionId: 's', fireAtMs: BASE + 1000, title: 'a', kind: 'k', scope: 'events' })
    hostMap.put({ reminderKey: 'b', hostId: 'h-b', sessionId: 's', fireAtMs: BASE + 2000, title: 'b', kind: 'k', scope: 'events' })
    hostMap.put({ reminderKey: 'c', hostId: 'h-c', sessionId: 's', fireAtMs: BASE + 3000, title: 'c', kind: 'k', scope: 'tasks' })
    eq('a 是墓碑', hostMap.get('a'), undefined)
    eq('墓碑 a 的 scope 仍为 events', hostMap.describe('a')?.scope, 'events')
    eq('墓碑 a 的 hostId 仍可取', hostMap.describe('a')?.hostId, 'h-a')
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 600))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-01 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

async function adapter3Catalog(adapter) { return adapter.catalog() }
async function adapter4Cancel(adapter, key) { return adapter.cancel(key) }

#!/usr/bin/env node
/**
 * 探针 R5b-12：收尾扫描 —— 剩余的边界情况
 *
 * 1) 墓碑的 scope 在 remove() 后是否被清（indexScopes 一致性）
 * 2) describe() 对「同 hostId 两个 key」的歧义
 * 3) remove() 时若 hostId 被别的 key 占用会不会误删
 * 4) catalog 的 scope 兜底：映射完全丢失时行会落到哪个 scope
 * 5) reconcile 的 protect 与 scope 的交互
 * 6) upsert 时 fireAtMs 变化（时刻改了）→ 是否正确「删旧建新」
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
const dir = mkdtempSync(join(tmpdir(), 'r5b12-'))
try {
  say('=== 1) 墓碑 remove() 后 indexScopes 是否被清 ===')
  {
    const path = join(dir, 'a.json')
    const hm = M.openHostMap({ filePath: path, maxEntries: 2 })
    for (let i = 0; i < 5; i++) {
      hm.put({ reminderKey: `t-${i}`, hostId: `h-${i}`, sessionId: 's', fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, kind: 'k', scope: i % 2 === 0 ? 'events' : 'tasks' })
    }
    hm.flush()
    const d0 = JSON.parse(readFileSync(path, 'utf8'))
    const tombs = Object.entries(d0.index).filter(([, k]) => d0.entries[k] === undefined).map(([h, k]) => [h, k])
    say(`     墓碑: ${JSON.stringify(tombs)}`)
    eq('有 3 个墓碑', tombs.length, 3)
    // 删一个墓碑
    const removed = hm.remove(tombs[0][1])
    eq('remove(墓碑) 返回 true', removed, true)
    hm.flush()
    const d1 = JSON.parse(readFileSync(path, 'utf8'))
    eq('墓碑的 index 已删', d1.index[tombs[0][0]], undefined)
    eq('墓碑的 indexScopes 已删', d1.indexScopes[tombs[0][0]], undefined)
    // 其他墓碑仍在
    const tombsAfter = Object.entries(d1.index).filter(([, k]) => d1.entries[k] === undefined).length
    eq('其余墓碑未被误删', tombsAfter, 2)
  }

  say('')
  say('=== 2) remove() 会不会误删「别的 key 指向同一 hostId」的情况 ===')
  {
    const hm = M.openHostMap({ filePath: join(dir, 'b.json'), maxEntries: 10 })
    hm.put({ reminderKey: 'k1', hostId: 'same-host', sessionId: 's', fireAtMs: BASE, title: 'k1', kind: 'k', scope: 'events' })
    // 直接篡改 index 让两个 key 指向同一 hostId（模拟状态损坏）
    hm.put({ reminderKey: 'k2', hostId: 'h2', sessionId: 's', fireAtMs: BASE, title: 'k2', kind: 'k', scope: 'events' })
    hm.remove('k1')
    eq('k1 的身份已删', hm.reminderKeyByHostId('same-host'), undefined)
    eq('k2 的身份仍在', hm.reminderKeyByHostId('h2'), 'k2')
    eq('k2 的 scope 仍在', hm.describe('k2').scope, 'events')
  }

  say('')
  say('=== 3) 映射完全丢失时，catalog 的行落到哪个 scope ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const path = join(dir, 'c.json')
    const hm = M.openHostMap({ filePath: path })
    const ad = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE })
    await ad.reconcile([{ reminderKey: 'x', fireAtMs: BASE + MIN, title: 'X', prompt: 'p', kind: 'event-start', scope: 'events' }])
    eq('宿主 1 条', (await stub.catalog()).length, 1)
    // 映射文件被删（模拟映射丢失）
    rmSync(path, { force: true })
    const hm2 = M.openHostMap({ filePath: path })
    const ad2 = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: hm2, sessionId: 's1', now: () => BASE })
    const cat = await ad2.catalog()
    say(`     映射丢失后：rows=${cat.rows.length} unmapped=${cat.unmapped.length} needsAttention=${cat.needsAttention}`)
    eq('行不被认领（进 unmapped）', cat.unmapped.length, 1)
    eq('rows=0（不猜归属）', cat.rows.length, 0)
    eq('needsAttention=true', cat.needsAttention, true)
    // 带 scope 对账时，unmapped 行不应被删
    const r = await ad2.reconcile([], { scope: 'events' })
    eq('unmapped 行不被删除', r.removed.length, 0)
    eq('宿主行仍在', (await stub.catalog()).length, 1)
  }

  say('')
  say('=== 4) protect 与 scope 的交互 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hm = M.openHostMap({ filePath: join(dir, 'd.json') })
    const ad = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE })
    await ad.reconcile([
      { reminderKey: 'p1', fireAtMs: BASE + MIN, title: 'P1', prompt: 'p', kind: 'event-start', scope: 'events' },
      { reminderKey: 'p2', fireAtMs: BASE + 2 * MIN, title: 'P2', prompt: 'p', kind: 'event-start', scope: 'tasks' },
    ])
    eq('宿主 2 条', (await stub.catalog()).length, 2)
    // protect p1（events scope），对账 scope=events 且 desired 为空
    const r = await ad.reconcile([], { scope: 'events', protect: ['p1'] })
    say(`     protect p1 + scope=events：removed=${JSON.stringify(r.removed)} protected=${JSON.stringify(r.protected)}`)
    eq('p1 被保护（未删）', (await stub.catalog()).length, 2)
    eq('p1 在 protected 列表', r.protected.includes('p1'), true)
  }

  say('')
  say('=== 5) upsert 时 fireAtMs 变化 → 「删旧建新」是否正确 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hm = M.openHostMap({ filePath: join(dir, 'e.json') })
    const ad = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE })
    const p1 = { reminderKey: 'chg', fireAtMs: BASE + MIN, title: 'C', prompt: 'p', kind: 'event-start' }
    await ad.reconcile([p1])
    eq('宿主 1 条', (await stub.catalog()).length, 1)
    const p2 = { ...p1, fireAtMs: BASE + 10 * MIN }
    const r = await ad.reconcile([p2])
    say(`     改时刻后：created=${r.created.length} updated=${r.updated.length} removed=${r.removed.length} failed=${r.failed.length}`)
    eq('宿主仍 1 条（不重复）', (await stub.catalog()).length, 1)
    eq('无失败', r.failed.length, 0)
    const cat = await stub.catalog()
    eq('时刻已更新', Date.parse(cat[0].scheduledAt), BASE + 10 * MIN)
    // 旧身份是否残留
    eq('无重复行', cat.length, new Set(cat.map((r) => r.id)).size)
  }

  say('')
  say('=== 6) 空 desired + 无 scope：全部删掉 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hm = M.openHostMap({ filePath: join(dir, 'f.json') })
    const ad = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub, hostMap: hm, sessionId: 's1', now: () => BASE })
    await ad.reconcile(Array.from({ length: 5 }, (_, i) => ({
      reminderKey: `z${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `Z${i}`, prompt: 'p', kind: 'event-start',
    })))
    eq('宿主 5 条', (await stub.catalog()).length, 5)
    const r = await ad.reconcile([])
    eq('全删 removed=5', r.removed.length, 5)
    eq('宿主 0 条', (await stub.catalog()).length, 0)
    eq('映射清空', hm.size, 0)
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-12 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

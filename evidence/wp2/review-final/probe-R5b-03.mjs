#!/usr/bin/env node
/**
 * 探针 R5b-03：BLOCKER-2 修法引入的新缺陷扫描
 *
 * 1) createLocks 的 promise 链是否泄漏（链条不清理 → Map 无限增长）
 * 2) upsert 抛异常时链条是否卡死（release 在 finally，验证）
 * 3) 时间老化会不会删掉「未投递的近期提醒」的身份（→ 重复投递）
 * 4) flush（脏标记）语义会不会在崩溃场景丢身份（→ 重复投递）
 * 5) remove() 清 index 时会不会误删别的 key 的身份（已在 probe-01 验过，这里交叉验）
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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
const DAY = 86_400_000
const dir = mkdtempSync(join(tmpdir(), 'r5b03-'))
try {
  say('=== 1) createLocks 的 promise 链是否泄漏 ===')
  {
    // 用 heap snapshot 精确定位 createLocks Map 的大小
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'l.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'leak', fireAtMs: BASE + MIN, title: 'L', prompt: 'p', kind: 'event-start' }
    for (let i = 0; i < 50; i++) await adapter.reconcile([plan])

    const sizeOfCreateLocks = async () => {
      const v8 = await import('node:v8')
      const snap = v8.getHeapSnapshot()
      let size = null
      const stack = [snap]
      while (stack.length > 0) {
        const node = stack.pop()
        for (const c of node.children ?? []) {
          if (c.name === 'createLocks') {
            // Map 节点的 children: [table, ...]; table 的 children 是 entries
            const table = c.children?.find((x) => x.name === 'table')
            const entries = table?.children?.find((x) => x.name === 'entries')
            size = entries?.children?.length ?? null
          }
          stack.push(c)
        }
      }
      snap.destroy()
      return size
    }
    const before = await sizeOfCreateLocks()
    say(`     50 次后 createLocks 大小 = ${before}`)
    for (let i = 0; i < 200; i++) await adapter.reconcile([plan])
    const after = await sizeOfCreateLocks()
    say(`     250 次后 createLocks 大小 = ${after}`)
    // 关键：链条按 key 累积。同一个 key 反复 upsert → Map 里只有 1 项（key 是 reminderKey）
    if (before !== null && before > 10) bad('createLocks 按调用次数累积（链条未清理）', `size=${before}`)
    else ok('createLocks 未按调用次数累积', `size=${before} → ${after}`)
  }

  say('')
  say('=== 1b) 不同 key 会不会在 createLocks 里永久堆积 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'lk.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plans = Array.from({ length: 300 }, (_, i) => ({
      reminderKey: `n-${i}`, fireAtMs: BASE + (i + 1) * MIN, title: `N${i}`, prompt: 'p', kind: 'event-start',
    }))
    await adapter.reconcile(plans)
    const v8 = await import('node:v8')
    const snap = v8.getHeapSnapshot()
    let size = null
    const stack = [snap]
    while (stack.length > 0) {
      const node = stack.pop()
      for (const c of node.children ?? []) {
        if (c.name === 'createLocks') {
          const table = c.children?.find((x) => x.name === 'table')
          const entries = table?.children?.find((x) => x.name === 'entries')
          size = entries?.children?.length ?? null
        }
        stack.push(c)
      }
    }
    snap.destroy()
    say(`     300 个不同 key 后 createLocks 大小 = ${size}`)
    // 这是「泄漏」：条目永不删除。每个 reminderKey 留一项 → 长期运行会涨
    if (size !== null && size > 100) {
      bad('createLocks 按不同 key 永久堆积（链条从不清理）', `size=${size}（300 个 key）`)
    } else {
      ok('createLocks 未堆积', `size=${size}`)
    }
  }

  say('')
  say('=== 2) upsert 抛异常时链条是否卡死 ===')
  {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'e.json') })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'boom', fireAtMs: BASE + MIN, title: 'B', prompt: 'p', kind: 'event-start' }
    const origCatalog = stub.catalog.bind(stub)
    let n = 0
    stub.catalog = async () => { n += 1; if (n === 1) throw new Error('catalog boom'); return origCatalog() }
    const r1 = await adapter.reconcile([plan])
    eq('catalog 抛错 → degraded', r1.degraded, true)
    eq('catalog 抛错 → 不删不建', r1.created.length + r1.removed.length, 0)
    stub.catalog = origCatalog
    // 链条没卡死 → 下一次能正常建
    const r2 = await adapter.reconcile([plan])
    eq('异常后链条未卡死（后续能建）', r2.created.length, 1)
    eq('宿主 1 条', (await stub.catalog()).length, 1)
  }

  say('')
  say('=== 3) 时间老化会不会删掉「未投递的近期提醒」的身份 ===')
  {
    // now 前进 200 天；一条 fireAtMs 在 200 天前的（远期提醒）应保留
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const hostMap = M.openHostMap({ filePath: join(dir, 'age.json'), now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => clock,
    })
    // 一条 10 天后触发的近期提醒
    const near = { reminderKey: 'near', fireAtMs: BASE + 10 * DAY, title: 'Near', prompt: 'p', kind: 'event-start' }
    const r1 = await adapter.reconcile([near])
    eq('近期提醒已建立', r1.created.length, 1)
    eq('身份存在', hostMap.get('near') !== undefined, true)
    // 时间跳到 200 天后
    clock = BASE + 200 * DAY
    hostMap.put({ reminderKey: 'near', hostId: 'schedule-1', sessionId: 's1', fireAtMs: BASE + 10 * DAY, title: 'Near', kind: 'event-start', scope: '' })
    const survived = hostMap.get('near')
    if (survived === undefined) {
      bad('近期提醒的身份被时间老化删掉（→ 重复投递风险）', 'near 身份丢失')
    } else {
      ok('近期提醒的身份未被时间老化删掉', `fireAtMs=${survived.fireAtMs}`)
    }
    // 一条 300 天前触发的老提醒应被删
    const old = { reminderKey: 'old', fireAtMs: BASE - 300 * DAY, title: 'Old', prompt: 'p', kind: 'event-start' }
    hostMap.put({ reminderKey: 'old', hostId: 'schedule-2', sessionId: 's1', fireAtMs: BASE - 300 * DAY, title: 'Old', kind: 'event-start', scope: '' })
    const oldAlive = hostMap.get('old')
    if (oldAlive !== undefined) {
      bad('超期提醒的身份未老化', 'old 仍存在')
    } else {
      ok('超期提醒的身份已老化', 'old 已删')
    }
    // 关键：老身份删掉后，宿主上仍活着的行会成为 unmapped → 会不会被重建？
    const cat = await adapter.catalog()
    say(`     老化后 catalog: rows=${cat.rows.length} unmapped=${cat.unmapped.length} needsAttention=${cat.needsAttention}`)
    const unmappedKeys = cat.unmapped.map((u) => u.title)
    say(`     unmapped 行: ${JSON.stringify(unmappedKeys)}`)
  }

  say('')
  say('=== 3b) 时间老化后，宿主上活着的行会不会被重建（重复投递）===')
  {
    let clock = BASE
    const stub = createContractStub({ now: () => clock })
    const hostMap = M.openHostMap({ filePath: join(dir, 'age2.json'), now: () => clock })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => clock,
    })
    const plan = { reminderKey: 'p', fireAtMs: BASE + 10 * DAY, title: 'P', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])
    eq('宿主 1 条', (await stub.catalog()).length, 1)
    // 时间跳 200 天后，fireAtMs(BASE+10d) < cutoff(BASE+20d) → 身份被老化
    clock = BASE + 200 * DAY
    hostMap.put({ reminderKey: 'p', hostId: 'schedule-1', sessionId: 's1', fireAtMs: BASE + 10 * DAY, title: 'P', kind: 'event-start', scope: '' })
    eq('身份已老化', hostMap.get('p'), undefined)
    // 宿主上那条还在（scheduledAt 在 10 天后，过去 200 天了……模拟宿主还留着）
    const cat = await adapter.catalog()
    eq('宿主行变 unmapped', cat.unmapped.length, 1)
    eq('needsAttention 为真', cat.needsAttention, true)
    // 若仍把该 plan 放进 desired → 会重建（宿主上已有 1 条）→ 重复
    const r = await adapter.reconcile([{ ...plan, fireAtMs: BASE + 210 * DAY }])
    say(`     重新对账: created=${r.created.length} 宿主行=${(await stub.catalog()).length}`)
    if ((await stub.catalog()).length > 1) {
      bad('老化后重建 → 宿主侧出现重复行', `宿主行=${(await stub.catalog()).length}`)
    } else {
      ok('老化后重建未造成重复（宿主行仍 1）', `宿主行=${(await stub.catalog()).length}`)
    }
  }

  say('')
  say('=== 4) flush（脏标记）语义：崩溃场景是否丢身份 ===')
  {
    // 4a) put 之后不 flush → 磁盘上没有身份 → 重启后认不出 → 重建 → 重复
    const mapPath = join(dir, 'f1.json')
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: mapPath })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const plan = { reminderKey: 'ff', fireAtMs: BASE + MIN, title: 'F', prompt: 'p', kind: 'event-start' }
    await adapter.reconcile([plan])
    eq('宿主 1 条', (await stub.catalog()).length, 1)
    const onDisk = JSON.parse(readFileSync(mapPath, 'utf8'))
    eq('身份已落盘（upsert 后立即 flush）', Object.keys(onDisk.index).length, 1)
    eq('dirty 已清', hostMap.dirty, false)

    // 4b) 直接调 hostMap.put 后不 flush → 崩溃 → 身份丢
    const mapPath2 = join(dir, 'f2.json')
    const hm2 = M.openHostMap({ filePath: mapPath2 })
    hm2.put({ reminderKey: 'lost', hostId: 'h1', sessionId: 's', fireAtMs: BASE, title: 'L', kind: 'k', scope: '' })
    eq('put 后 dirty=true', hm2.dirty, true)
    const hm3 = M.openHostMap({ filePath: mapPath2 })
    eq('未 flush 时重启：身份丢失', hm3.get('lost'), undefined)
    eq('未 flush 时重启：index 也为空', Object.keys(JSON.parse(readFileSync(mapPath2, 'utf8')).index ?? {}).length, 0)
  }

  say('')
  say('=== 5) removeByHostId 会不会误删别的 key ===')
  {
    const hm = M.openHostMap({ filePath: join(dir, 'rb.json'), maxEntries: 10 })
    hm.put({ reminderKey: 'p1', hostId: 'h1', sessionId: 's', fireAtMs: BASE + 1000, title: 'p1', kind: 'k', scope: 'events' })
    hm.put({ reminderKey: 'p2', hostId: 'h2', sessionId: 's', fireAtMs: BASE + 2000, title: 'p2', kind: 'k', scope: 'events' })
    hm.removeByHostId('h1')
    eq('p1 已被删', hm.get('p1'), undefined)
    eq('p1 身份已删', hm.reminderKeyByHostId('h1'), undefined)
    eq('p2 仍在', hm.get('p2') !== undefined, true)
    eq('p2 身份仍在', hm.reminderKeyByHostId('h2'), 'p2')
  }

} catch (error) {
  bad('探针异常', String(error?.stack ?? error).slice(0, 900))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say('')
say(`=== 探针 R5b-03 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

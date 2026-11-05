#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 12：墓碑（被裁剪条目）无法删除 —— 可达性与影响刻画。
 *
 * 探针 05 已证实：>500 条后，被裁剪成墓碑的提醒**删不掉**（failed=not-found / scope 过滤掉）。
 *
 * 本探针刻画三件关键事实，决定它是不是 blocker：
 *   (1) **裁剪顺序**：谁变墓碑？（最近要响的，还是最远的？）
 *   (2) **cancel 也失效**：用户主动取消一个即将响的提醒会怎样？
 *   (3) **scope 隔离失守**：带 scope 对账时墓碑行被静默跳过（连 failed 都不记）
 *
 * 对比：R5-1 之前的实现是把条目整条删除 → 认不出宿主行 → **重复创建**（重复投递）。
 * R5-1 改成墓碑后：认得出（不重复）但**删不掉**（幽灵提醒）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000
let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const note = (n) => say(`    ℹ️  ${n}`)
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const tmp = () => mkdtempSync(join(tmpdir(), 'r5p12-'))

say('=== WP2R5-Final 探针 12：墓碑不可删除的可达性与影响 ===')
say('')

// ---------- (1) 裁剪顺序 ----------
say('--- 1) 裁剪顺序：谁变墓碑？---')
{
  const dir = tmp()
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const all = Array.from({ length: 600 }, (_, i) => mk(i))
    await adapter.reconcile(all)
    const tombs = all.filter((p) => hostMap.get(p.reminderKey) === undefined)
    const idx = tombs.map((p) => Number(p.reminderKey.slice(2)))
    say(`    墓碑数: ${tombs.length}`)
    say(`    墓碑的 key 序号范围: ${Math.min(...idx)} .. ${Math.max(...idx)}`)
    note(`    key 序号越小 = fireAtMs 越早 = 越快到点`)
    if (Math.max(...idx) === 599) {
      ok('裁剪保留「最晚的 500 条」，被裁的是**最早到点**的 100 条')
      say('    → 被裁的正是**最先要响**的那批提醒')
    } else {
      note('裁剪保留的是别的顺序')
    }
    // 最先到点的那条是否已成墓碑？
    const soonest = all[0]
    note(`    最先到点的 ${soonest.reminderKey} 是否墓碑: ${hostMap.get(soonest.reminderKey) === undefined}`)
  } catch (error) {
    bad('场景 1 异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (2) cancel 失效 ----------
say('')
say('--- 2) 用户主动 cancel 一个已变墓碑的提醒 ---')
{
  const dir = tmp()
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const all = Array.from({ length: 600 }, (_, i) => mk(i))
    await adapter.reconcile(all)
    const victim = all[0]  // 已被裁成墓碑
    note(`    受害者 ${victim.reminderKey} 是墓碑: ${hostMap.get(victim.reminderKey) === undefined}`)
    let thrown = null
    try {
      await adapter.cancel(victim.reminderKey)
    } catch (error) {
      thrown = error
    }
    const rows = (await stub.catalog()).length
    say(`    cancel 结果: ${thrown === null ? '成功' : `抛错 ${thrown.code ?? thrown.message}`}`)
    say(`    宿主仍保留 ${rows} 行（该提醒仍在宿主上，到点仍会响）`)
    if (thrown !== null && rows === 600) {
      bad('cancel 墓碑提醒失败 → 幽灵提醒（用户已取消，宿主仍会投递）')
    } else {
      ok('cancel 成功')
    }
    // 对照：未超上限时 cancel 正常
    const dir2 = tmp()
    try {
      const stub2 = createContractStub({ now: () => BASE })
      const hm2 = M.openHostMap({ filePath: join(dir2, 'm.json'), maxEntries: 500 })
      const ad2 = M.createScheduleAdapter({ backend: 'host', hostSchedule: stub2, hostMap: hm2, sessionId: 's1', now: () => BASE })
      await ad2.reconcile(all.slice(0, 300))
      await ad2.cancel(all[0].reminderKey)
      eq('对照组（300 条，未超上限）cancel 后宿主 299 行', (await stub2.catalog()).length, 299)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  } catch (error) {
    bad('场景 2 异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- (3) scope 隔离失守 ----------
say('')
say('--- 3) 带 scope 对账时，墓碑行被静默跳过（连 failed 都不记）---')
{
  const dir = tmp()
  try {
    const stub = createContractStub({ now: () => BASE })
    const hostMap = M.openHostMap({ filePath: join(dir, 'm.json'), maxEntries: 500 })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
    })
    const mk = (i) => ({
      reminderKey: `k-${String(i).padStart(4, '0')}`,
      fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
    })
    const all = Array.from({ length: 600 }, (_, i) => mk(i))
    await adapter.reconcile(all, { scope: 'events' })
    const r = await adapter.reconcile(all.slice(300), { scope: 'events' })
    const rows = (await stub.catalog()).length
    say(`    removed=${r.removed.length} failed=${r.failed.length} 宿主行=${rows}（期望 300）`)
    say('    注意：failed 也是 0 —— 这些行被 scope 过滤掉了，**没有任何可观察信号**')
    if (rows > 300) bad(`带 scope 时墓碑行被静默跳过：宿主残留 ${rows - 300} 行，且 failed=0（无告警）`)
    else ok('带 scope 时删除正常')
  } catch (error) {
    bad('场景 3 异常', String(error?.stack ?? error).slice(0, 400))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

say('')
say('=== 探针 12 汇总 ===')
say('')
say(`  失败项: ${fail}`)
process.exit(fail > 0 ? 1 : 0)

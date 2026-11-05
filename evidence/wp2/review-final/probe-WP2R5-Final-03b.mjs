#!/usr/bin/env node
/** 探针 03b：诊断 entries=250 / 少 250 行的原因。 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
const M = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createContractStub } = await import(`${FREEZE}/workbench-core/test/helpers/contract-stub.mjs`)

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const MIN = 60_000
const dir = mkdtempSync(join(tmpdir(), 'r5p3b-'))
try {
  const stub = createContractStub({ now: () => BASE })
  const mapPath = join(dir, 'm.json')
  const hostMap = M.openHostMap({ filePath: mapPath, maxEntries: 500 })
  const adapter = M.createScheduleAdapter({
    backend: 'host', hostSchedule: stub, hostMap, sessionId: 's1', now: () => BASE,
  })
  const mk = (i) => ({
    reminderKey: `k-${String(i).padStart(5, '0')}`,
    fireAtMs: BASE + (i + 1) * MIN, title: `T${i}`, prompt: 'p', kind: 'event-start',
  })
  // 先建 2000（events + tasks 两 scope）
  const ev = Array.from({ length: 1000 }, (_, i) => mk(i * 2))
  const tk = Array.from({ length: 1000 }, (_, i) => mk(i * 2 + 1))
  await adapter.reconcile(ev, { scope: 'events' })
  await adapter.reconcile(tk, { scope: 'tasks' })
  console.log('建完 2000: host=', (await stub.catalog()).length, 'entries=', hostMap.size)

  // 现在再加 1000 条新 key，fireAtMs 与前 1000 条相同（模拟同窗口的新事件）
  const batch = Array.from({ length: 1000 }, (_, i) => ({
    reminderKey: `round0-${String(i).padStart(4, '0')}`,
    fireAtMs: BASE + (i + 1) * MIN, title: `R${i}`, prompt: 'p', kind: 'event-start',
  }))
  const r = await adapter.reconcile(batch, { scope: 'events' })
  console.log('第 1 轮 1000 条: created=', r.created.length, 'updated=', r.updated.length,
    'removed=', r.removed.length, 'failed=', JSON.stringify(r.failed.slice(0, 3)))
  console.log('  host=', (await stub.catalog()).length, 'entries=', hostMap.size)
  const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
  console.log('  磁盘: entries=', Object.keys(raw.entries).length, 'index=', Object.keys(raw.index).length)

  // 检查失败原因分布
  const reasons = {}
  for (const f of r.failed) reasons[f.reason ?? '?'] = (reasons[f.reason ?? '?'] ?? 0) + 1
  console.log('  failed 原因分布:', JSON.stringify(reasons))
  if (r.failed.length > 0) console.log('  首个 failed:', JSON.stringify(r.failed[0]))
} catch (e) {
  console.log('异常', e.stack)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

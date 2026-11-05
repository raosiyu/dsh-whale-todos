#!/usr/bin/env node
/**
 * **L4：真实 ScheduleService 端到端**（不是 stub）。
 *
 * 第三轮 Review 指出：我此前把 L4 标为 BLOCKED 是错的——用真实的 cordis
 * `Context` + 一个内存 storageDomain 就能 `new ScheduleService(...)` 并跑通
 * 五个方法。不可达的只是「完整 Host」，不是「真 Service 类」。
 *
 * 本脚本做三件事：
 *   1. 用真 Context + 假 storageDomain 实例化真实 ScheduleService
 *   2. 在真实代码上跑 create / list / catalog / history / delete
 *   3. 把真实 Service 喂给适配器，验证 reconcile 端到端（含 5 次重启去重）
 *
 * 诚实边界：假 storageDomain 不等价真实 Host 的 fiber/effect 生命周期，
 * 所以这证明的是「真实 Service 类可实例化并跑通五方法 + 适配器与之兼容」，
 * **不是**生产环境端到端。
 *
 * 用法：node scripts/r3-real-service.mjs
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScheduleAdapter, openHostMap } from '../workbench-core/src/index.js'

const FULL = '/tmp/dsh-asar-full/dsh/node_modules'
const log = (...a) => console.log(...a)
let fail = 0
const ok = (n, e = '') => { log(`  ✅ ${n}${e ? '  ' + e : ''}`) }
const bad = (n, e = '') => { log(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const eq = (n, got, want) => (got === want ? ok(n, `= ${JSON.stringify(got)}`) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))

if (!existsSync(`${FULL}/@deepseek-ai/dsh-schedule/lib/index.js`)) {
  log(`BLOCKED：未找到解包目录 ${FULL}`)
  log('先运行：npx @electron/asar extract "<app.asar>" /tmp/dsh-asar-full')
  process.exit(2)
}

log('=== 1) 用真实 Context 实例化真实 ScheduleService ===')
const { Context } = await import(`${FULL}/@deepseek-ai/cordis/lib/index.js`)
const mod = await import(`${FULL}/@deepseek-ai/dsh-schedule/lib/index.js`)

const rows = new Map()
const domain = {
  table: () => ({
    entries: () => [...rows.entries()],
    get: (id) => rows.get(id),
    put: async (id, v) => { rows.set(id, v) },
    delete: async (id) => { rows.delete(id) },
  }),
  close: async () => {},
}
const ctx = new Context()
for (const name of ['storageDomain', 'agents', 'sessions', 'sessionController', 'sessionPersistence']) {
  try { ctx.provide(name) } catch { /* 已存在则忽略 */ }
}
ctx.set('storageDomain', { open: async () => domain })
ctx.set('agents', { get: () => undefined })
ctx.set('sessions', {})
ctx.set('sessionController', {})
ctx.set('sessionPersistence', {})

let svc
try {
  svc = new mod.ScheduleService(ctx, { deliveryHistoryDays: 30, deliveryHistoryRecords: 200 })
  ok('真实 ScheduleService 实例化成功')
} catch (error) {
  bad('实例化失败', String(error?.message ?? error).slice(0, 200))
  process.exit(1)
}

log('')
log('=== 2) 真实代码上跑五个方法 ===')
const sid = 'session-r3-real'
const at = new Date(Date.now() + 3600_000).toISOString()

let rec
try {
  rec = await svc.create(sid, { title: '真实验证', prompt: 'p', at })
  ok('create(sessionId, {title,prompt,at}) 成功', JSON.stringify(rec))
  Object.isFrozen(rec) ? ok('record 是 frozen') : bad('record 未冻结')
  !('key' in rec) ? ok('record 无 key 字段（身份必须本地持久化）') : bad('record 含 key')
} catch (error) {
  bad('create 失败', `${error?.code} ${error?.message}`)
}

if (rec !== undefined) {
  const listed = await svc.list({ sessionId: sid })
  eq('list({sessionId}) 返回 1 条', listed.length, 1)

  const cat = await svc.catalog()
  eq('catalog() 返回 1 条', cat.length, 1)

  const hist = await svc.history({ sessionId: sid, id: rec.id, limit: 100 })
  Array.isArray(hist.records) ? ok('history 返回 records 数组', `len=${hist.records.length}`) : bad('history 形状不对')

  try {
    await svc.history({ sessionId: sid, id: rec.id, limit: 0 })
    bad('history limit=0 未被拒')
  } catch (e) {
    eq('history limit=0 被拒（invalid_rule）', e.code, 'invalid_rule')
  }

  // 契约：at 传数字必须被拒
  try {
    await svc.create(sid, { title: 'x', prompt: 'p', at: Date.now() + 3600_000 })
    bad('at 传数字未被拒')
  } catch (e) {
    eq('at 传数字被拒', e.code, 'invalid_rule')
  }
}

log('')
log('=== 3) 适配器 × 真实 Service 端到端 ===')
const work = mkdtempSync(join(tmpdir(), 'r3-realsvc-'))
try {
  const mapPath = join(work, 'hostmap.json')
  const plan = { reminderKey: 'k-real', fireAtMs: Date.now() + 7200_000, title: '端到端', prompt: 'p', kind: 'event-start' }

  // 5 次"重启"：每次新 hostMap + 新 adapter（真实 Service 是持久的）
  for (let i = 0; i < 5; i += 1) {
    const hostMap = openHostMap({ filePath: mapPath })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule: svc, hostMap, sessionId: sid, now: () => Date.now(),
    })
    await adapter.reconcile([plan])
  }
  const cat = await svc.catalog()
  const mine = cat.filter((r) => r.sessionId === sid && r.title === '端到端')
  eq('5 次重启后真实宿主仍只有 1 条', mine.length, 1)

  // 幂等：再对账不变
  const hostMap = openHostMap({ filePath: mapPath })
  const adapter = createScheduleAdapter({
    backend: 'host', hostSchedule: svc, hostMap, sessionId: sid, now: () => Date.now(),
  })
  const again = await adapter.reconcile([plan])
  eq('重复对账 created=0', again.created.length, 0)
  eq('重复对账 failed=0', again.failed.length, 0)

  // 清空对账：active 应被删，inactive 保留
  const cleared = await adapter.reconcile([])
  ok('清空对账未抛错', `removed=${cleared.removed.length} failed=${cleared.failed.length}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

log('')
log('=== 汇总 ===')
log(fail === 0 ? 'RESULT: L4 PASS（真 Service 类 + 适配器端到端）' : `RESULT: FAIL（${fail} 项）`)
log('边界：假 storageDomain ≠ 真实 Host 的 fiber/effect 生命周期；生产端到端仍 UNVERIFIED。')
process.exit(fail > 0 ? 1 : 0)

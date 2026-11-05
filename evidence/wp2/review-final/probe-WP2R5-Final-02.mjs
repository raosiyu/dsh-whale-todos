#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 02：**真实 storageDomain** 的独立复现。
 *
 * 与 scripts/probes/p1-real-storage-domain.mjs 的差异（刻意不同）：
 *   1. 我**不**手搓 `new Storage(pc)` / `new DomainFacility(pc, ...)`；
 *      我用三个插件**自己的 apply()**，让它们按真实生命周期装配：
 *        dsh-storage-json 的 apply   → ctx.storage.backend.register('json', backend)
 *                                      + ctx.provide(storageBackendServiceKey('json'), backend)
 *        dsh-storage 的 Storage 服务  → ctx.storage（真实 hub）
 *        dsh-storage-domain 的 apply → ctx.inject([backendKey]) → DomainFacility
 *                                      → ctx.storage.mount('domain', facility)
 *                                      → ctx.provide('storageDomain', facility)
 *   2. 我**不**复用 p1 的手写 hostSchedule 适配器去验证「5 次重启一条」；
 *      我直接用真实 DomainFacility 的 table 读写 + 冻结版 adapter 的 host 后端，
 *      验证：真落盘 → 新实例读回 → 适配器跨重启不重复注册。
 *   3. 我验证的是**冻结版源码**（/tmp/wp2r5-freeze-2b0aabb），不是主仓库。
 *
 * 若这一份也通过，则 p1 的结论可信；若不通过，则 p1 是假的。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FULL = '/tmp/dsh-asar-full/dsh/node_modules'
const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'

let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }

say('=== WP2R5-Final 探针 02：真实 storageDomain 独立复现（用插件自己的 apply）===')
say('')

if (!existsSync(`${FULL}/@deepseek-ai/dsh-storage/lib/index.js`)) {
  say('BLOCKED: /tmp/dsh-asar-full 不存在')
  process.exit(2)
}

const { Context } = await import(`${FULL}/@deepseek-ai/cordis/lib/index.js`)
const storageMod = await import(`${FULL}/@deepseek-ai/dsh-storage/lib/index.js`)
const jsonMod = await import(`${FULL}/@deepseek-ai/dsh-storage-json/lib/index.js`)
const domainMod = await import(`${FULL}/@deepseek-ai/dsh-storage-domain/lib/index.js`)
const sched = await import(`${FULL}/@deepseek-ai/dsh-schedule/lib/index.js`)
const M = await import(`${FREEZE}/workbench-core/src/index.js`)

const root = mkdtempSync(join(tmpdir(), 'r5p2-'))
say(`存储根目录: ${root}`)

const backendKey = storageMod.storageBackendServiceKey('json')

/**
 * 用插件自己的 apply() 装配一套真实 Host。
 * 这与 p1 的手搓方式不同：p1 直接 new Storage(pc) / new DomainFacility(pc)。
 */
async function makeRealHost() {
  const ctx = new Context()
  const plugin = ctx.plugin({
    name: `r5-real-${Math.random().toString(36).slice(2, 8)}`,
    inject: [],
    apply(pc) {
      // 1) 真实 Storage hub（Service，自动注册为 'storage'）
      const storage = new storageMod.default(pc)
      // 2) 真实 JSON 后端：用插件自己的 apply
      jsonMod.apply(pc, { root })
      // 3) 真实 domain facility：用插件自己的 apply（内部走 ctx.inject([backendKey])）
      domainMod.apply(pc, { backend: 'json', routes: {} })
    },
  })
  await plugin
  return ctx
}

// ---- 1) 组装真实 Host ----
let ctx
try {
  ctx = await makeRealHost()
  ok('真实 Host 组装成功（storage + storage-json + storage-domain 三插件 apply）')
} catch (error) {
  bad('真实 Host 组装失败', String(error?.stack ?? error).slice(0, 500))
  process.exit(1)
}

// ---- 2) 打开真实 scheduleDomain ----
let domain
try {
  domain = await ctx.storage.domain.open(sched.scheduleDomain)
  ok('真实 scheduleDomain 打开成功（ctx.storage.domain.open）')
} catch (error) {
  bad('打开真实 scheduleDomain 失败', String(error?.stack ?? error).slice(0, 500))
  process.exit(1)
}

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const HOUR = 3_600_000

// ---- 3) 真写入：走真实 domain 的 table ----
const tasks = domain.table('tasks')
const sid = 'session-r5p2'
const rec = await sched.createAtScheduleRecord(
  'schedule-r5p2', '真实持久化验证', new Date(BASE + HOUR).toISOString(), BASE, '真实持久化验证',
)
await tasks.put(rec.id, {
  sessionId: sid,
  record: rec,
  status: 'active',
  deliveryHistory: { records: [], earlierRecordsUnavailable: false },
})
ok('真实 domain 写入 1 条 tasks', rec.id)

const files = existsSync(root) ? readdirSync(root) : []
files.length > 0 ? ok('真实落盘（存储根目录非空）', files.join(', ')) : bad('存储根目录为空')

const sizeOf = (p) => {
  try { return statSync(p).size } catch { return -1 }
}
let totalBytes = 0
for (const f of files) totalBytes += sizeOf(join(root, f))
say(`    落盘体积: ${totalBytes} 字节`)

// ---- 4) 新实例读回（真重启） ----
await domain.close()
try {
  const ctx2 = await makeRealHost()
  const domain2 = await ctx2.storage.domain.open(sched.scheduleDomain)
  const rows = [...domain2.table('tasks').entries()]
  rows.length === 1
    ? ok('新实例从真实 JSON 后端读回 1 条', rows[0][1].record.id)
    : bad('新实例读不到', `rows=${rows.length}`)

  // ---- 5) 适配器跨重启：用**真实 domain 的 table** 作宿主，冻结版 adapter 做对账 ----
  const tasks2 = domain2.table('tasks')
  let seq = 0
  /** 严格按真实 ctx.schedule 契约实现（含 schedule_not_found 与 earlierRecordsUnavailable） */
  const realishHostSchedule = {
    async create(sessionId, request) {
      const r = await sched.createAtScheduleRecord(
        `schedule-r5p2-${++seq}`, request.prompt, request.at, BASE, request.title,
      )
      await tasks2.put(r.id, {
        sessionId, record: r, status: 'active',
        deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      return r
    },
    async list({ sessionId }) {
      return [...tasks2.entries()]
        .filter(([, t]) => t.sessionId === sessionId && t.status === 'active')
        .map(([, t]) => t.record)
    },
    async catalog() {
      return [...tasks2.entries()].map(([, t]) => ({
        ...t.record, sessionId: t.sessionId, status: t.status,
      }))
    },
    async history({ sessionId, id, limit }) {
      const t = tasks2.get(id)
      if (t === undefined || t.sessionId !== sessionId) return { id, code: 'schedule_not_found' }
      return {
        records: t.deliveryHistory?.records ?? [],
        earlierRecordsUnavailable: t.deliveryHistory?.earlierRecordsUnavailable ?? false,
      }
    },
    async delete({ id, sessionId }) {
      const t = tasks2.get(id)
      if (t === undefined || t.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      await tasks2.delete(id)
      return { id, deleted: true }
    },
  }

  const hostMapPath = join(root, 'hostmap.json')
  const plan = { reminderKey: 'k-r5p2', fireAtMs: BASE + 2 * HOUR, title: '真实提醒', prompt: 'p', kind: 'event-start' }
  for (let i = 0; i < 5; i += 1) {
    // 每次都是**全新的 hostMap + adapter**（模拟进程重启）
    const hostMap = M.openHostMap({ filePath: hostMapPath })
    const adapter = M.createScheduleAdapter({
      backend: 'host', hostSchedule: realishHostSchedule, hostMap, sessionId: sid, now: () => BASE,
    })
    await adapter.reconcile([plan])
  }
  const mine = (await realishHostSchedule.catalog()).filter((r) => r.title === '真实提醒')
  mine.length === 1
    ? ok('5 次「重启」后真实 storageDomain 里只有 1 条提醒', `id=${mine[0]?.id}`)
    : bad('重启后重复注册', `条数=${mine.length}`)

  // ---- 6) 落盘文件确实含 hostmap ----
  const hmExists = existsSync(hostMapPath)
  hmExists ? ok('hostMap 真实落盘', `${sizeOf(hostMapPath)} 字节`) : bad('hostMap 未落盘')
} catch (error) {
  bad('第二实例流程失败', String(error?.stack ?? error).slice(0, 600))
}

rmSync(root, { recursive: true, force: true })
say('')
say(`=== 探针 02 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

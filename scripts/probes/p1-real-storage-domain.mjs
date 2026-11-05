#!/usr/bin/env node
/**
 * 探针 P1：**真实 storageDomain** 持久化 + 进程重启 + 提醒恢复。
 *
 * 上一轮 L4 用的是内存假 domain；本探针全用真实组件：
 *   - 真 `@deepseek-ai/cordis` Context
 *   - 真 `@deepseek-ai/dsh-storage` Storage hub
 *   - 真 `@deepseek-ai/dsh-storage-json` JsonStorageBackend（落盘到临时目录）
 *   - 真 `@deepseek-ai/dsh-storage-domain` 的 DomainFacility
 *   - 真 `@deepseek-ai/dsh-schedule` scheduleDomain
 *
 * 验证：写 → close → **新实例**读回 → 数据仍在；
 *       适配器跨「重启」（新 hostMap + 新 adapter）不重复注册。
 *
 * 用法：node scripts/probes/p-real-storage-domain.mjs [证据输出路径]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const FULL = '/tmp/dsh-asar-full/dsh/node_modules'
const REPO = '/Users/sylas/Developer/dsh-workbench'
const OUT = process.argv[2] ?? join(REPO, 'evidence', 'wp2', 'review-final', 'p1-real-storage-domain.log')

const lines = []
const say = (...a) => { const s = a.join(' '); console.log(s); lines.push(s) }
const flush = () => { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') }

let fail = 0
const ok = (n, e = '') => { say(`  ✅ ${n}${e ? '  ' + e : ''}`); flush() }
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1; flush() }
const eq = (n, g, w) => (g === w ? ok(n, `= ${JSON.stringify(g)}`) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`))

const BASE = Date.UTC(2026, 10, 5, 0, 0, 0)
const HOUR = 3_600_000

say('=== P1 真实 storageDomain：持久化 / 重启 / 提醒恢复 ===')
flush()

if (!existsSync(`${FULL}/@deepseek-ai/dsh-storage/lib/index.js`)) {
  say('BLOCKED: 未找到解包目录，先跑 npx @electron/asar extract')
  flush()
  process.exit(2)
}

const { Context } = await import(`${FULL}/@deepseek-ai/cordis/lib/index.js`)
const storageMod = await import(`${FULL}/@deepseek-ai/dsh-storage/lib/index.js`)
const { JsonStorageBackend } = await import(`${FULL}/@deepseek-ai/dsh-storage-json/lib/index.js`)
const domainMod = await import(`${FULL}/@deepseek-ai/dsh-storage-domain/lib/index.js`)
const sched = await import(`${FULL}/@deepseek-ai/dsh-schedule/lib/index.js`)
const { createScheduleAdapter, openHostMap } = await import(`${REPO}/workbench-core/src/index.js`)

const root = mkdtempSync(join(tmpdir(), 'p1-realstore-'))
say(`存储根目录: ${root}`)
flush()

const backendKey = storageMod.storageBackendServiceKey('json')

/**
 * 搭一套最小真实 Host（照抄 dsh-storage-domain 的 apply 流程）：
 *   ctx.inject([backendKey], cb) → cb 内建 DomainFacility 并 mount 到 hub
 */
async function makeHost() {
  const ctx = new Context()
  const holder = {}

  // 用 plugin 形式拿到**插件 context**（Service 必须在插件 context 里构造，
  // 根 Context 没有 reflect，new Storage(ctx) 会直接抛错）
  const fiber = ctx.plugin({
    name: `storage-host-${Math.random().toString(36).slice(2, 8)}`,
    inject: [],
    apply(pc) {
      // Storage 构造时已自动注册为 'storage'，不要重复 provide
      const storage = new storageMod.default(pc)
      const backend = new JsonStorageBackend(root)
      storage.backend.register('json', backend)
      pc.provide(backendKey, backend)

      // domain facility：挂到 hub，并 provide('storageDomain')
      const facility = new domainMod.DomainFacility(pc, { backend: 'json', routes: {} })
      pc.effect(() => {
        const unmount = pc.storage.mount('domain', facility)
        return async () => { await facility.closeAll(); unmount() }
      })
      pc.provide('storageDomain', facility)
      holder.storage = storage
      holder.facility = facility
    },
  })
  await fiber
  return { ctx, ...holder }
}

let host
try {
  host = await makeHost()
  ok('真实 Storage hub + JSON 后端 + domain facility 组装成功')
} catch (error) {
  bad('组装真实 Host 失败', String(error?.message ?? error).slice(0, 240))
  flush()
  process.exit(1)
}

const { ctx } = host
let domain
try {
  domain = await ctx.storage.domain.open(sched.scheduleDomain)
  ok('真实 scheduleDomain 打开成功（storageDomain → JSON 后端）')
} catch (error) {
  bad('打开真实 scheduleDomain 失败', String(error?.message ?? error).slice(0, 240))
  flush()
  process.exit(1)
}

const tasks = domain.table('tasks')
const sid = 'session-p1'
const at = new Date(BASE + HOUR).toISOString()
const rec = await sched.createAtScheduleRecord('schedule-p1', '真实持久化验证', at, BASE, '真实持久化验证')
await tasks.put(rec.id, {
  sessionId: sid,
  record: rec,
  status: 'active',
  deliveryHistory: { records: [], earlierRecordsUnavailable: false },
})
ok('真实 domain 写入一条 tasks', rec.id)

say('')
say('--- 1) 落盘检查（真实文件）---')
const files = existsSync(root) ? readdirSync(root) : []
files.length > 0 ? ok('存储根目录已落盘', files.join(', ')) : bad('存储根目录为空，没有落盘')

say('')
say('--- 2) 新实例读回（模拟进程重启）---')
await domain.close()
try {
  const host2 = await makeHost()
  const domain2 = await host2.ctx.storage.domain.open(sched.scheduleDomain)
  const rows = [...domain2.table('tasks').entries()]
  rows.length === 1 ? ok('重启后从真实 JSON 后端读到 1 条', rows[0][1].record.id) : bad('重启后读不到', `rows=${rows.length}`)

  say('')
  say('--- 3) 适配器跨重启不重复注册（真实 storageDomain）---')
  const tasks2 = domain2.table('tasks')
  let seq = 0
  const hostSchedule = {
    create: async (sessionId, request) => {
      const r = await sched.createAtScheduleRecord(
        `schedule-${++seq}`,
        request.prompt, request.at, BASE, request.title,
      )
      await tasks2.put(r.id, {
        sessionId, record: r, status: 'active',
        deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      return r
    },
    list: async ({ sessionId }) => [...tasks2.entries()]
      .filter(([, t]) => t.sessionId === sessionId && t.status === 'active').map(([, t]) => t.record),
    catalog: async () => [...tasks2.entries()]
      .map(([, t]) => ({ ...t.record, sessionId: t.sessionId, status: t.status })),
    history: async ({ sessionId, id }) => {
      const t = tasks2.get(id)
      if (t === undefined || t.sessionId !== sessionId) return { id, code: 'schedule_not_found' }
      return {
        records: t.deliveryHistory?.records ?? [],
        earlierRecordsUnavailable: t.deliveryHistory?.earlierRecordsUnavailable ?? false,
      }
    },
    delete: async ({ id, sessionId }) => {
      const t = tasks2.get(id)
      if (t === undefined || t.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      await tasks2.delete(id)
      return { id, deleted: true }
    },
  }

  const hostMapPath = join(root, 'hostmap.json')
  const plan = { reminderKey: 'k-real', fireAtMs: BASE + 2 * HOUR, title: '真实提醒', prompt: 'p', kind: 'event-start' }
  for (let i = 0; i < 5; i += 1) {
    const hostMap = openHostMap({ filePath: hostMapPath })
    const adapter = createScheduleAdapter({
      backend: 'host', hostSchedule, hostMap, sessionId: sid, now: () => BASE,
    })
    await adapter.reconcile([plan])
  }
  const mine = (await hostSchedule.catalog()).filter((r) => r.title === '真实提醒')
  eq('5 次重启后真实 storageDomain 里只有 1 条提醒', mine.length, 1)
} catch (error) {
  bad('第二实例流程失败', String(error?.message ?? error).slice(0, 240))
}

rmSync(root, { recursive: true, force: true })
say('')
say(`=== P1 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
flush()
process.exit(fail > 0 ? 1 : 0)

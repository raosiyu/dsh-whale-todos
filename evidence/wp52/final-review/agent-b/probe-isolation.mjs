/**
 * WP5.2 独立审查 Agent B · 探针 1：跨 session / scope 隔离
 *
 * 目标（实证，不看注释）：
 *  Q1 session-A 能否删/改 session-B 的提醒？scope-A 能否踩踏 scope-B？
 *  Q2 dataDirFor() 与 forSession() 目录规则是否真一致？有无第二份 hash 实现？
 *      缓存命中时 sessionEntries 是否必然存在？
 *  Q3 ownershipCache 是否按 sessionId\0scope 分键（不串味）？
 *
 * 手法：import 冻结副本的 .js（ESM），构造可控的 mock schedule，
 *       精确记录每次 create/update/delete/catalog 的入参。
 * 只读业务代码；不修改任何冻结/主仓库文件。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  createReminderSync, encodePrompt, reminderIdentity, ownershipOf,
  identityOfHostRecord,
} from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/reminder-sync.js'
import { createWorkbenchHostService } from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/host-service.js'

const NOW = Date.parse('2026-11-07T00:00:00.000Z')
const FUTURE = '2026-11-08T12:00:00.000Z'
const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }

/** 可控的 mock schedule：catalog 返回「全表」（模拟真实 dsh-schedule 不过滤 session）。 */
function makeSchedule() {
  const rows = new Map()
  let seq = 0
  const calls = { create: [], update: [], delete: [], catalog: 0 }
  return {
    _rows: rows, calls,
    async catalog() {
      calls.catalog += 1
      // 真实 dsh-schedule: table('tasks').entries() —— 返回所有 session，无过滤
      return [...rows.values()].map((r) => ({ ...r }))
    },
    async create(sessionId, rec) {
      calls.create.push({ sessionId, rec })
      const id = `schedule-${++seq}`
      rows.set(id, { id, sessionId, ...rec, scheduledAt: rec.at, status: 'active' })
      return { id, kind: 'at', scheduledAt: rec.at }
    },
    async update(req) {
      calls.update.push(req)
      const row = rows.get(req.id)
      if (row === undefined) return { updated: false, code: 'schedule_not_found' }
      Object.assign(row, { title: req.title, prompt: req.prompt, scheduledAt: req.change.at })
      return { id: req.id, updated: true }
    },
    async delete(req) {
      calls.delete.push(req)
      // 模拟真实 Host 守卫：会话不匹配返回 deleted:false，不抛错
      const row = rows.get(req.id)
      if (row !== undefined && row.sessionId !== req.sessionId) {
        return { id: req.id, deleted: false, code: 'session_mismatch' }
      }
      rows.delete(req.id)
      return { id: req.id, deleted: true }
    },
    async history() { return { records: [] } },
  }
}

const mkTask = (id, title, dueAt = FUTURE) => ({ id, title, dueAt, done: false, deleted: false })

/** 纯内存 ownershipFor：按 (sessionId, scope) 落独立 Map，用于验证分键。 */
function makeOwnershipFor() {
  const stores = new Map()
  const resolved = []
  return {
    resolved,
    resolver(sid, scope) {
      const key = `${sid}\u0000${scope}`
      resolved.push(key)
      if (!stores.has(key)) stores.set(key, new Set())
      const ids = stores.get(key)
      return {
        load: () => [...ids],
        save: (arr) => { ids.clear(); for (const x of arr) ids.add(x) },
      }
    },
  }
}

// ---------------------------------------------------------------------------
hr('Q1.1 catalog 全表 + ownHostRecords 的 sessionId 过滤链')
// ---------------------------------------------------------------------------
{
  const sched = makeSchedule()
  // 预置：session-B 有一条「带合法标记」的提醒，identity 与 A 期望集合无关
  const bIdentity = reminderIdentity('task', 'B-only', '')
  await sched.create('session-B', {
    title: 'B 的提醒', prompt: encodePrompt('B 的提醒正文', bIdentity), at: FUTURE,
  })
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const report = await sync.reconcile('session-A', { tasks: [] }, '')
  line(`session-A reconcile report: ${JSON.stringify({
    created: report.created, updated: report.updated, deleted: report.deleted,
    kept: report.kept, observed: report.observed, failed: report.failed,
    catalogAvailable: report.catalogAvailable,
  })}`)
  line(`schedule.delete calls: ${JSON.stringify(sched.calls.delete)}`)
  line(`schedule.create calls: ${JSON.stringify(sched.calls.create)}`)
  const bStillThere = [...sched._rows.values()].some((r) => r.sessionId === 'session-B')
  assert(sched.calls.delete.length === 0, 'session-A 对 session-B 的记录没有发起任何 delete')
  assert(bStillThere === true, 'session-B 的提醒仍在（未被跨 session 删除）')
  assert(report.deleted === 0 && report.observed.length === 0,
    'ownHostRecords 的 sessionId 过滤在 ownershipOf 之前，B 的记录连 observed 都不进（不进入 diff）')
}

// ---------------------------------------------------------------------------
hr('Q1.2 session-A 尝试「修改」session-B 的记录（update 路径）')
// ---------------------------------------------------------------------------
{
  const sched = makeSchedule()
  const identity = reminderIdentity('task', 'shared-id', '')
  // session-B 有一条与 A 期望 identity 相同的记录（模拟同 identity 跨 session 碰撞）
  await sched.create('session-B', {
    title: 'B 版本', prompt: encodePrompt('B 正文', identity), at: FUTURE,
  })
  const createsBefore = sched.calls.create.length
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('session-A', { tasks: [mkTask('shared-id', 'A 版本')] }, '')
  line(`report: ${JSON.stringify({ created: r.created, updated: r.updated, deleted: r.deleted })}`)
  line(`create calls AFTER reconcile: ${JSON.stringify(sched.calls.create.slice(createsBefore))}`)
  line(`update calls: ${JSON.stringify(sched.calls.update)}`)
  const bRow = [...sched._rows.values()].find((x) => x.sessionId === 'session-B')
  assert(sched.calls.update.length === 0, 'session-A 没有 update session-B 的记录')
  const newCreates = sched.calls.create.slice(createsBefore)
  assert(newCreates.length === 1 && newCreates[0].sessionId === 'session-A',
    'A 在自己 session 下新建，而不是踩踏/复用 B 的记录')
  assert(bRow.title === 'B 版本', 'B 的记录内容未被改动')
}

// ---------------------------------------------------------------------------
hr('Q1.3 scope A 能否踩踏/删除 scope B（同 session，不同 scope）')
// ---------------------------------------------------------------------------
{
  const sched = makeSchedule()
  const own = makeOwnershipFor()
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor: own.resolver })
  // scope projA 与 projB 各建一条（同实体 id，identity 因 scope 不同）
  await sync.reconcile('s1', { tasks: [mkTask('same-id', 'A')] }, 'projA')
  await sync.reconcile('s1', { tasks: [mkTask('same-id', 'B')] }, 'projB')
  const ids = [...sched._rows.values()].map((r) => identityOfHostRecord(r))
  line(`两条 identity: ${JSON.stringify(ids)}`)
  assert(ids.length === 2 && ids[0] !== ids[1], '同实体 id 在两个 scope 下 identity 不同（scope 进身份）')
  // 现在对 projA 传空数据（期望删除 projA 的提醒），看是否误删 projB
  const delCallsBefore = sched.calls.delete.length
  const r = await sync.reconcile('s1', { tasks: [] }, 'projA')
  line(`reconcile(projA, empty) report: ${JSON.stringify({ deleted: r.deleted, kept: r.kept, observed: r.observed })}`)
  line(`delete calls: ${JSON.stringify(sched.calls.delete.slice(delCallsBefore))}`)
  const remaining = [...sched._rows.values()].map((x) => identityOfHostRecord(x))
  line(`remaining identities: ${JSON.stringify(remaining)}`)
  assert(r.deleted === 1, 'projA 只删除自己 scope 的那一条')
  assert(remaining.length === 1 && remaining[0] === ids[1], 'projB 的提醒未被删除/踩踏')
  // scope-mismatch 的记录应进入 observed（可观测），而不是静默
  assert(r.observed.some((o) => o.level === 'suspect' && o.reason === 'scope-mismatch'),
    'projB 的记录被标为 suspect/scope-mismatch 并上报 observed（不静默丢弃）')
}

// ---------------------------------------------------------------------------
hr('Q1.4 ownershipCache 按 sessionId\\0scope 分键（不串味）')
// ---------------------------------------------------------------------------
{
  const sched = makeSchedule()
  const own = makeOwnershipFor()
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor: own.resolver })
  await sync.reconcile('sessA', { tasks: [mkTask('t1', 'A')] }, 'sc')
  // sessB 用空数据：其白名单必须为空 → 不会删 sessA 的记录（且 sessionId 过滤已挡住）
  const r = await sync.reconcile('sessB', { tasks: [] }, 'sc')
  line(`ownershipFor resolved keys: ${JSON.stringify(own.resolved)}`)
  line(`sessB reconcile deleted=${r.deleted} kept=${JSON.stringify(r.kept)}`)
  assert(own.resolved.includes('sessA\u0000sc') && own.resolved.includes('sessB\u0000sc'),
    'ownershipFor 分别收到 sessA\\0sc 与 sessB\\0sc 两个独立键')
  // 重复 reconcile 同一 (sid,scope) 不应再次 resolve（缓存命中）
  const before = own.resolved.length
  await sync.reconcile('sessA', { tasks: [mkTask('t1', 'A')] }, 'sc')
  line(`resolved keys 数量 before=${before} after=${own.resolved.length}`)
  assert(own.resolved.length === before, '同一 (sessionId,scope) 命中 ownershipCache，不再重复 resolve')
  assert(r.deleted === 0, 'sessB 没有删除任何记录（sessionId 过滤 + 独立白名单）')
}

// ---------------------------------------------------------------------------
hr('Q2 dataDirFor() 与 forSession() 落盘目录一致性 + 第二份 hash 检查')
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'wp52-b-isolation-'))
  try {
    const svc = createWorkbenchHostService({ rootDir: root })
    const cases = [
      ['sess-1', ''],
      ['sess-1', 'projB'],
      ['sess-tricky', 'a::b::c'],
      ['another-session', 'projB'],
    ]
    for (const [sid, scope] of cases) {
      const dd = svc.dataDirFor(sid, scope)
      // 用 forSession(sid, scope) 写一条数据，看文件是否落在 dd
      svc.invoke(sid, 'event.create', {
        title: 'x', allDay: false,
        start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00',
        timeZone: 'Asia/Shanghai',
      }, { scope })
      const f = join(dd, 'workbench.json')
      const ok = existsSync(f)
      line(`sid=${sid} scope=${JSON.stringify(scope)} dataDirFor=${dd} workbench.json存在=${ok}`)
      assert(ok, `dataDirFor(${sid},${scope}) 指向的目录 == forSession 实际写盘目录`)
      // 验证该目录名规则：s-<sha256(sessionId)[0:24]>[-<sha256(scope)[0:12]>]
      const expected = `s-${createHash('sha256').update(sid).digest('hex').slice(0, 24)}`
        + (scope === '' ? '' : `-${createHash('sha256').update(scope).digest('hex').slice(0, 12)}`)
      line(`  目录 basename=${dd.split('/').pop()} 期望=${expected}`)
      assert(dd.split('/').pop() === expected, `目录名规则与 host-service.js 内唯一一份 hash 实现一致`)
    }
    // 两个 scope 不共用目录
    assert(svc.dataDirFor('sess-1', '') !== svc.dataDirFor('sess-1', 'projB'), 'scope 进目录路径')
    // scope 含 :: 时 openedSessions 原样返回（结构化 sessionEntries，不反解析）
    const opened = svc.openedSessions()
    const hit = opened.find((e) => e.scope === 'a::b::c')
    line(`openedSessions 中 a::b::c: ${JSON.stringify(hit)}`)
    assert(hit !== undefined && hit.sessionId === 'sess-tricky', 'scope 含 :: 时 openedSessions 不拆错（sessionEntries 结构化）')
    // 缓存命中：重复 dataDirFor 返回同一路径（sessionEntries.get 命中）
    const a1 = svc.dataDirFor('sess-1', 'projB')
    const a2 = svc.dataDirFor('sess-1', 'projB')
    assert(a1 === a2, '重复 dataDirFor 返回同一路径（sessionEntries 缓存命中必然存在）')
    // 静态检查：冻结副本里 createHash('sha256') 出现位置（第二份 hash 实现核查）
    const src = readFileSync('/tmp/wp52-freeze-e9b2b32/workbench-core/src/host-service.js', 'utf8')
    const occurrences = (src.match(/createHash\('sha256'\)/g) || []).length
    line(`host-service.js 内 createHash('sha256') 出现次数=${occurrences}（sessionDirName / scopeSuffix / dataDirFor 兜底）`)
    const bridge = readFileSync('/tmp/wp52-freeze-e9b2b32/packages/workbench-ui/index.js', 'utf8')
    line(`UI 桥接层含 createHash? ${bridge.includes('createHash')}`)
    assert(bridge.includes('createHash') === false, 'UI 桥接层没有第二份 sha256 实现（统一走 dataDirFor）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

line('\n=== probe-isolation 结束 ===')

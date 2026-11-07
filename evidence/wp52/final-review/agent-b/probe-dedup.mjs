/**
 * WP5.2 独立审查 Agent B · 探针 2：真实投递去重 / 幂等
 *
 * 目标（实证）：
 *  Q3 同一 identity 连续 reconcile 两次，会不会重复 create → 重复投递？
 *     diffReminders 的 unchanged 判据可靠否？
 *  额外对抗：scope 含冒号时 decodeIdentity / ownershipOf 是否还自洽？
 *    （若不自洽 → 自家记录被排除 → 重复 create → 重复投递，P0）
 *
 * 手法：mock schedule 精确计 create/update/delete 次数；对同一份数据连续对账。
 * 只读业务代码；不修改任何冻结/主仓库文件。
 */
import {
  createReminderSync, encodePrompt, identityOfHostRecord, ownershipOf,
  decodeIdentity, diffReminders, reminderIdentity,
} from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/reminder-sync.js'

const NOW = Date.parse('2026-11-07T00:00:00.000Z')
const FUTURE = '2026-11-08T12:00:00.000Z'
const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }

function makeSchedule() {
  const rows = new Map()
  let seq = 0
  const calls = { create: [], update: [], delete: [] }
  return {
    _rows: rows, calls,
    async catalog() { return [...rows.values()].map((r) => ({ ...r })) },
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
      const row = rows.get(req.id)
      if (row !== undefined && row.sessionId !== req.sessionId) return { id: req.id, deleted: false, code: 'session_mismatch' }
      rows.delete(req.id)
      return { id: req.id, deleted: true }
    },
    async history() { return { records: [] } },
  }
}
const mkTask = (id, title, dueAt = FUTURE) => ({ id, title, dueAt, done: false, deleted: false })

// ---------------------------------------------------------------------------
hr('Q3.1 同一 identity 连续 reconcile 两次（含白名单持久化）')
// ---------------------------------------------------------------------------
{
  const sched = makeSchedule()
  const stores = new Map()
  const ownershipFor = (sid, scope) => {
    const k = `${sid}\u0000${scope}`
    if (!stores.has(k)) stores.set(k, new Set())
    const ids = stores.get(k)
    return { load: () => [...ids], save: (a) => { ids.clear(); for (const x of a) ids.add(x) } }
  }
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', '买牛奶')], events: [] }
  const r1 = await sync.reconcile('s1', data, '')
  line(`r1: created=${r1.created} updated=${r1.updated} unchanged=${r1.unchanged} deleted=${r1.deleted}`)
  line(`create calls after r1: ${sched.calls.create.length}`)
  const r2 = await sync.reconcile('s1', data, '')
  line(`r2: created=${r2.created} updated=${r2.updated} unchanged=${r2.unchanged} deleted=${r2.deleted}`)
  line(`create calls after r2: ${sched.calls.create.length}`)
  line(`update calls total: ${sched.calls.update.length}`)
  assert(sched.calls.create.length === 1, '连续两次 reconcile 只 create 1 次（无重复注册→无重复投递）')
  assert(r2.created === 0 && r2.updated === 0 && r2.unchanged === 1, '第二次 reconcile 判定 unchanged（不重复 create/update）')
  const oneRow = [...sched._rows.values()][0]
  line(`Host row prompt: ${JSON.stringify(oneRow.prompt)}`)
  line(`identityOfHostRecord(row): ${identityOfHostRecord(oneRow)}`)
  assert(identityOfHostRecord(oneRow) === reminderIdentity('task', 't1', ''), 'Host 上存的 prompt 能被反解出正确 identity')
}

// ---------------------------------------------------------------------------
hr('Q3.2 diffReminders 的 unchanged 判据：时间/文本/编码基准')
// ---------------------------------------------------------------------------
{
  const identity = reminderIdentity('task', 'x', '')
  const desired = new Map([[identity, {
    identity, title: 'T', prompt: '正文', fireAtMs: Date.parse(FUTURE),
  }]])
  // (a) 完全一致：scheduledAt 与 fireAtMs 相等，prompt 是 encodePrompt 结果
  const exact = { id: 'r1', title: 'T', prompt: encodePrompt('正文', identity), scheduledAt: FUTURE }
  const d1 = diffReminders([exact], desired)
  line(`(a) exact → unchanged=${JSON.stringify(d1.unchanged)} toUpdate=${d1.toUpdate.length} toCreate=${d1.toCreate.length}`)
  assert(d1.unchanged.length === 1 && d1.toUpdate.length === 0 && d1.toCreate.length === 0,
    'unchanged 判据：scheduledAt 相等 + title 相等 + prompt===encodePrompt(want)')
  // (b) 带合法标记但正文不同（模拟旧实现「拿未编码原文比较」恒不等的回归语义）：
  //     row.prompt 是 encodePrompt('旧正文')，want.prompt 是 '正文' → 必须判 update
  const taggedOld = { id: 'r1', title: 'T', prompt: encodePrompt('旧正文', identity), scheduledAt: FUTURE }
  const d2 = diffReminders([taggedOld], desired)
  line(`(b) 标记合法但正文变化 → unchanged=${JSON.stringify(d2.unchanged)} toUpdate=${d2.toUpdate.length}`)
  assert(d2.toUpdate.length === 1 && d2.unchanged.length === 0,
    '比较基准是 encodePrompt(want)，正文变化判 update（而非恒 unchanged/恒 update）')
  // (c) 时间变了 → update
  const moved = { id: 'r1', title: 'T', prompt: encodePrompt('正文', identity), scheduledAt: '2026-11-09T12:00:00.000Z' }
  const d3 = diffReminders([moved], desired)
  line(`(c) 时间变化 → toUpdate=${d3.toUpdate.length}`)
  assert(d3.toUpdate.length === 1 && d3.unchanged.length === 0, '时间变化判 update（走 update 而非 create，不换 identity）')
  // (d) 标题变了 → update
  const retitled = { id: 'r1', title: 'T2', prompt: encodePrompt('正文', identity), scheduledAt: FUTURE }
  const d4 = diffReminders([retitled], desired)
  line(`(d) 标题变化 → toUpdate=${d4.toUpdate.length}`)
  assert(d4.toUpdate.length === 1, '标题变化判 update')
}

// ---------------------------------------------------------------------------
hr('Q3.3 重启后（新 sync 实例 + 白名单从文件恢复）是否重复 create')
// ---------------------------------------------------------------------------
{
  const sched = makeSchedule()
  const stores = new Map()
  const ownershipFor = (sid, scope) => {
    const k = `${sid}\u0000${scope}`
    if (!stores.has(k)) stores.set(k, new Set())
    const ids = stores.get(k)
    return { load: () => [...ids], save: (a) => { ids.clear(); for (const x of a) ids.add(x) } }
  }
  const sync1 = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', '买牛奶')] }
  await sync1.reconcile('s1', data, '')
  line(`实例1 后 create=${sched.calls.create.length} 白名单=${JSON.stringify([...stores.get('s1\u0000')])}`)
  // 新实例，同一个 schedule（模拟进程重启，Host 持久化任务仍在）
  const sync2 = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const r = await sync2.reconcile('s1', data, '')
  line(`实例2 后 create=${sched.calls.create.length} report.created=${r.created} unchanged=${r.unchanged}`)
  assert(sched.calls.create.length === 1 && r.created === 0 && r.unchanged === 1,
    '重启后不重复 create（白名单持久化 + catalog 识别 + unchanged）')
  // 删除后白名单也应收缩
  const rdel = await sync2.reconcile('s1', { tasks: [] }, '')
  line(`删除后 report.deleted=${rdel.deleted} 白名单=${JSON.stringify([...stores.get('s1\u0000')])}`)
  assert(rdel.deleted === 1 && stores.get('s1\u0000').size === 0, '删除后白名单同步收缩')
}

// ---------------------------------------------------------------------------
hr('Q3.4 【对抗】scope 含冒号：decodeIdentity / ownershipOf 是否仍自洽')
// ---------------------------------------------------------------------------
{
  // 业务 scope 可以是任意字符串；UI 桥接层 scope 来自 parsed.req.scope（用户/工具可给）
  const scopes = ['projA', 'a::b', 'x:y:z', 'proj:sub']
  for (const scope of scopes) {
    const identity = reminderIdentity('task', 'e1', scope)
    const parts = decodeIdentity(identity)
    const row = { id: 'r', prompt: encodePrompt('正文', identity), title: 'T', sessionId: 's1' }
    const own = ownershipOf(row, { scope })
    const back = own.level === 'owned' ? own.identity : null
    line(`scope=${JSON.stringify(scope)} identity=${JSON.stringify(identity)}`)
    line(`  decodeIdentity → ${JSON.stringify(parts)}  ownershipOf → ${own.level}/${own.reason ?? ''}  identity=${back}`)
    // 关键：自家写入的记录必须被判 owned，否则会被排除出 diff → 重复 create → 重复投递
    assert(own.level === 'owned', `scope=${JSON.stringify(scope)} 的自家记录必须判 owned（否则重复 create）`)
    assert(parts !== null && parts.scope === scope, `decodeIdentity 应还原 scope=${JSON.stringify(scope)}`)
  }
}

// ---------------------------------------------------------------------------
hr('Q3.5 【对抗】含冒号 scope 的端到端 reconcile 是否重复 create')
// ---------------------------------------------------------------------------
{
  const scope = 'a::b'
  const sched = makeSchedule()
  const stores = new Map()
  const ownershipFor = (sid, sc) => {
    const k = `${sid}\u0000${sc}`
    if (!stores.has(k)) stores.set(k, new Set())
    const ids = stores.get(k)
    return { load: () => [...ids], save: (a) => { ids.clear(); for (const x of a) ids.add(x) } }
  }
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', 'A')] }
  const r1 = await sync.reconcile('s1', data, scope)
  const r2 = await sync.reconcile('s1', data, scope)
  line(`scope='a::b' r1.created=${r1.created} r2.created=${r2.created} r2.unchanged=${r2.unchanged} r2.observed=${JSON.stringify(r2.observed)}`)
  line(`总 create 次数=${sched.calls.create.length}  Host 行数=${sched._rows.size}`)
  assert(sched.calls.create.length === 1 && r2.created === 0 && r2.unchanged === 1,
    `含冒号 scope 连续 reconcile 不重复 create（无重复投递）`)
}

line('\n=== probe-dedup 结束 ===')

/**
 * WP5.1：提醒投递（reminder-sync）。
 *
 * 这个文件的判据全部来自**隔离实例实测**，不是设计推演：
 *  - `ctx.schedule` 在真实 Host 里存在，`create/update/delete/catalog/history` 都是函数；
 *  - `catalog()` 条目是 **扁平** `ScheduleRecord & {sessionId,status,lastDelivery?}`，
 *    没有嵌套 `record`（types.d.ts:184 + 实测首条）；
 *  - 持久化落 `<DSH_HOME>/storages/schedule.json`，重启后 `catalog()` 仍读回 `status:'active'`；
 *  - 投递语义是「原 Session 的后续消息」，**不是 macOS 系统通知**。
 *
 * 这里用 **假 schedule**（记录调用的内存实现）验证同步逻辑，
 * 真实 Host 路径由 `/tmp` 隔离实例的探针单独验证（见 evidence/wp5.1/）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createReminderSync,
  decodeIdentity,
  diffReminders,
  encodePrompt,
  identityOfHostRecord,
  ownershipOf,
  IDENTITY_MARK_OPEN,
  IDENTITY_FORMAT_V2,
  MAX_REMINDER_PROMPT,
  MAX_REMINDER_TITLE,
  recordOf,
  reminderForEvent,
  reminderForTask,
  reminderIdentity,
  reminderTitle,
} from '../src/reminder-sync.js'

/** 造一个假 Host schedule，行为对齐实测契约。 */
function fakeSchedule() {
  let seq = 0
  const rows = new Map()
  const calls = { create: [], update: [], delete: [], catalog: 0, history: [] }
  let catalogFails = false

  return {
    calls,
    rows,
    failCatalog(v) { catalogFails = v },
    async create(sessionId, req) {
      calls.create.push({ sessionId, req })
      const id = `schedule-fake-${++seq}`
      const row = {
        id,
        kind: 'at',
        title: req.title,
        prompt: req.prompt,
        scheduledAt: new Date(Date.parse(req.at)).toISOString(),
        sessionId,
        status: 'active',
      }
      rows.set(id, row)
      return row
    },
    async catalog() {
      calls.catalog += 1
      if (catalogFails) throw Object.assign(new Error('storage unavailable'), { code: 'storage-unavailable' })
      return [...rows.values()]
    },
    async update(req) {
      calls.update.push(req)
      const row = rows.get(req.id)
      if (row === undefined) return { id: req.id, updated: false, code: 'schedule_not_found' }
      /**
       * **模拟真实 Host 的会话守卫**（`lib/index.js`：`current.sessionId !==
       * request.sessionId` → `schedule_not_found`）。假的 delete/update 若比真实
       * Host 宽松，跨 session 误删就永远测不出来 —— 这是审查 P2-9 指出的
       * 结构性缺口，测试替身必须先对齐真实守卫。
       */
      if (row.sessionId !== req.sessionId) {
        return { id: req.id, updated: false, code: 'schedule_not_found' }
      }
      // compare-and-update：expected 必须与当前记录一致
      if (req.expected !== undefined && req.expected.id !== undefined && req.expected.id !== row.id) {
        return { id: req.id, updated: false, code: 'schedule_conflict' }
      }
      if (req.title !== undefined) row.title = req.title
      if (req.prompt !== undefined) row.prompt = req.prompt
      if (req.change !== undefined) row.scheduledAt = new Date(Date.parse(req.change.at)).toISOString()
      return { id: req.id, updated: true, record: recordOf(row) }
    },
    async delete(req) {
      calls.delete.push(req)
      const row = rows.get(req.id)
      if (row === undefined) return { id: req.id, deleted: false, code: 'schedule_not_found' }
      // 同 update：会话不匹配一律删不掉
      if (row.sessionId !== req.sessionId) {
        return { id: req.id, deleted: false, code: 'schedule_not_found' }
      }
      rows.delete(req.id)
      return { id: req.id, deleted: true }
    },
    async history(req) {
      calls.history.push(req)
      return {
        id: req.id,
        records: [],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
      }
    },
  }
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const mkTask = (id, title, dueAt, extra = {}) => ({
  id, title, dueAt, done: false, status: 'planned', ...extra,
})
const mkEvent = (id, title, start, extra = {}) => ({
  id, title, start, allDay: false, ...extra,
})

// ---------------------------------------------------------------- 身份与标题

test('reminderIdentity：身份含类型 + scope + id，不含时间与标题，且带版本标识', () => {
  // WP5.2-P0：格式改为 `wb2.<kind>.<b64url(scope)>.<b64url(entityId)>`
  const id0 = reminderIdentity('task', 't1')
  assert.ok(id0.startsWith(`${IDENTITY_FORMAT_V2}.`), `必须带版本前缀，实际 ${id0}`)
  assert.equal(id0.split('.').length, 4, '段数固定为 4')
  // 带 scope：不同 scope 必须算出不同身份（审查 P0-4）
  assert.notEqual(reminderIdentity('task', 't1', 'projA'), reminderIdentity('task', 't1', 'projB'))
  assert.notEqual(reminderIdentity('task', 't1', 'projA'), reminderIdentity('task', 't1'))
  assert.notEqual(reminderIdentity('task', 't1', ''), reminderIdentity('task', 't1', '_'),
    '空 scope 与真实 scope "_" 必须可区分（旧格式在此撞车）')
  // 同一实体的身份恒定 —— 改期/改标题只走 update，不换身份
  assert.equal(reminderIdentity('task', 't1', 's'), reminderIdentity('task', 't1', 's'))
})

test('WP5.2-P0：任意 scope/entityId 的编码解码必须完全一致（含冒号与 Unicode）', () => {
  const scopes = ['', '_', 'projA', 'a::b', 'proj:sub', 'x:y:z', '中文作用域',
    'with space', 'dots.in.scope', 'emoji🙂', 'a.b::c', 'tab\there', ']]', '[[wb:']
  const ids = ['t1', 'a::b', 'id:with:colons', '中文id', 'x.y', 'a]]b']
  for (const sc of scopes) {
    for (const eid of ids) {
      const id = reminderIdentity('task', eid, sc)
      const d = decodeIdentity(id)
      assert.ok(d !== null, `必须可解：scope=${JSON.stringify(sc)} id=${JSON.stringify(eid)}`)
      assert.equal(d.kind, 'task')
      assert.equal(d.scope, sc, `scope 往返失败：${JSON.stringify(sc)}`)
      assert.equal(d.entityId, eid, `entityId 往返失败：${JSON.stringify(eid)}`)
      assert.notEqual(d.legacyAmbiguous, true, 'v2 不得标记为歧义')
    }
  }
  // event-start 同样成立
  const ev = reminderIdentity('event-start', 'e:1', 'a::b')
  assert.deepEqual(decodeIdentity(ev), { kind: 'event-start', scope: 'a::b', entityId: 'e:1' })
})

test('reminderTitle：空标题兜底、超长截断到 Host 上限 120', () => {
  assert.equal(reminderTitle('  正常标题  ', 't1'), '正常标题')
  assert.equal(reminderTitle('', 't1'), '待办 t1')
  assert.equal(reminderTitle(undefined, 't9'), '待办 t9')
  const long = 'x'.repeat(200)
  const out = reminderTitle(long, 't1')
  assert.equal(out.length, MAX_REMINDER_TITLE)
  assert.equal(MAX_REMINDER_TITLE, 120, 'Host 的 MAX_TITLE_LENGTH 是 120')
})

test('encodePrompt / identityOfHostRecord：标记可往返，且不会被正文里的字样误判', () => {
  const encoded = encodePrompt('正文', reminderIdentity('task','t1'))
  assert.equal(identityOfHostRecord({ prompt: encoded }), reminderIdentity('task','t1'))
  // 非本插件写入的记录（无标记）必须返回 null，绝不误删
  assert.equal(identityOfHostRecord({ prompt: '用户自己建的提醒' }), null)
  assert.equal(identityOfHostRecord({}), null)
  assert.equal(identityOfHostRecord(null), null)
  // 标记必须在**结尾**才算，正文中间出现同样字样不算
  assert.equal(identityOfHostRecord({ prompt: '[[wb:task:t9]] 后面的正文' }), null)
})

test('decodeIdentity：v2 无歧义；v1 旧格式可识别但标记 legacyAmbiguous', () => {
  // v2：干净解出
  assert.deepEqual(decodeIdentity(reminderIdentity('task', 't1', 'projA')),
    { kind: 'task', scope: 'projA', entityId: 't1' })

  // v1 三段，scope 无歧义 → 不标记
  assert.deepEqual(decodeIdentity('task:projA:t1'),
    { kind: 'task', scope: 'projA', entityId: 't1' })

  // v1 三段，`_` 占位与真实 scope `_` 撞车 → 标记歧义（安全侧）
  assert.equal(decodeIdentity('task:_:t1').legacyAmbiguous, true)
  assert.equal(decodeIdentity('event-start:_:e1').legacyAmbiguous, true)

  // v1 两段（不含第二个冒号）：必然是「无 scope」，但 entityId 边界仍不可知 → 标记歧义
  assert.equal(decodeIdentity('task:t1').legacyAmbiguous, true)
  // v1 三段且 scope 名、id 都不含冒号：按 v1 规范解释为 scope='a', id='b'（无歧义）
  assert.deepEqual(decodeIdentity('task:a:b'), { kind: 'task', scope: 'a', entityId: 'b' })
  // v1 三段但 id 自身含冒号 → 与「无 scope」撞车 → 标记歧义
  assert.equal(decodeIdentity('task:projA:a:b').legacyAmbiguous, true)

  assert.equal(decodeIdentity('nonsense'), null)
  assert.equal(decodeIdentity(''), null)
  assert.equal(decodeIdentity('wb2.bad'), null, 'v2 段数不足必须拒绝')
  assert.equal(decodeIdentity('wb2.unknown.aS5.dA'), null, '未知 kind 必须拒绝')
})

// ---------------------------------------------------------------- 期望集合推导

test('reminderForTask：软删/已完成/空白 dueAt/已过期 都不产生提醒', () => {
  const future = '2026-11-08T12:00:00.000Z'
  assert.equal(reminderForTask(mkTask('t1', 'A', future), NOW).value.kind, 'task')
  assert.equal(reminderForTask(mkTask('t2', 'A', future, { deleted: true }), NOW).value, null)
  assert.equal(reminderForTask(mkTask('t3', 'A', future, { done: true }), NOW).value, null)
  assert.equal(reminderForTask(mkTask('t4', 'A', ''), NOW).value, null)
  assert.equal(reminderForTask(mkTask('t5', 'A', '   '), NOW).value, null)
  assert.equal(reminderForTask(mkTask('t6', 'A', null), NOW).value, null)
  // 已过期：不补注册
  assert.equal(reminderForTask(mkTask('t7', 'A', '2026-11-06T12:00:00.000Z'), NOW).value, null)
})

test('reminderForTask：非法 dueAt 必须**显式上报**，不能静默当成没有', () => {
  for (const bad of ['排序验证', 'not-a-date', '2026-13-45T99:99:99Z']) {
    const r = reminderForTask(mkTask('t1', 'A', bad), NOW)
    assert.equal(r.ok, false, `${bad} 应被判定为非法`)
    assert.equal(r.reason, 'invalid-dueAt')
  }
  // 缺少显式时区后缀的也算非法：Date.parse 对它们过于宽松
  for (const loose of ['2026-11-10', '2026-11-10T09:00:00', '2026/11/10']) {
    assert.equal(reminderForTask(mkTask('t1', 'A', loose), NOW).ok, false, `${loose} 缺时区应被拒`)
  }
})

test('reminderForTask：合法值原样使用，不做时区改写', () => {
  const r = reminderForTask(mkTask('t1', 'A', '2026-11-08T20:00:00+08:00'), NOW)
  assert.equal(r.ok, true)
  assert.equal(r.value.fireAtMs, Date.parse('2026-11-08T20:00:00+08:00'))
  assert.equal(r.value.fireAtMs, Date.parse('2026-11-08T12:00:00.000Z'))
})

test('reminderForEvent：全天日程不提醒，非法 start 显式上报', () => {
  assert.equal(reminderForEvent(mkEvent('e0', '全天', '2026-11-08T09:00:00', { allDay: true }), NOW).value, null)
  assert.equal(reminderForEvent(mkEvent('e1', '正常', '2026-11-08T09:00:00'), NOW).value.kind, 'event-start')
  assert.equal(reminderForEvent(mkEvent('e2', '坏', 'xx'), NOW).ok, false)
  assert.equal(reminderForEvent(mkEvent('e3', '过期', '2026-11-06T09:00:00'), NOW).value, null)
  assert.equal(reminderForEvent(mkEvent('e4', '已删', '2026-11-08T09:00:00', { deletedAt: '2026-11-07T00:00:00Z' }), NOW).value, null)
})

// ---------------------------------------------------------------- 差异

test('diffReminders：只对变化项产出 update，未变化进 unchanged', () => {
  const K = reminderIdentity('task', 't1')
  const existing = [{
    id: 'h1',
    title: 'A',
    prompt: encodePrompt('待办「A」到期了。', K),
    scheduledAt: '2026-11-08T12:00:00.000Z',
  }]
  const same = new Map([[K, {
    identity: K, title: 'A', prompt: '待办「A」到期了。',
    fireAtMs: Date.parse('2026-11-08T12:00:00.000Z'),
  }]])
  const d1 = diffReminders(existing, same)
  assert.equal(d1.toUpdate.length, 0)
  assert.equal(d1.toCreate.length, 0)
  assert.equal(d1.toDelete.length, 0)
  assert.deepEqual(d1.unchanged, [K])

  // **W52 锁**：比较基准必须是**编码后**的 prompt。
  //
  // 实测修复前（拿 want.prompt 直接比），同一份数据每次 reconcile 都被判成
  // 「需要更新」：R2/R3 恒为 updated:2，幂等彻底失效。
  // 这里的判据是反向的：Host 上已有的就是编码后的文本，因此**必须判为未变化**。
  const d2 = diffReminders([{ ...existing[0], prompt: encodePrompt('待办「A」到期了。', K) }], same)
  assert.equal(d2.toUpdate.length, 0, '编码后的 prompt 与自身相等 → 不得 update')
  assert.deepEqual(d2.unchanged, [K])

  // 而正文真的变了，仍然要 update（否则修幂等就修成了「永不更新」）
  const d3 = diffReminders([{ ...existing[0], prompt: encodePrompt('正文已改', K) }], same)
  assert.equal(d3.toUpdate.length, 1, '正文变化必须 update')

  // 改期 → update
  const moved = new Map([[K, { ...same.get(K), fireAtMs: Date.parse('2026-11-09T12:00:00.000Z') }]])
  assert.equal(diffReminders(existing, moved).toUpdate.length, 1)

  // 改标题 → update
  const renamed = new Map([[K, { ...same.get(K), title: 'A2' }]])
  assert.equal(diffReminders(existing, renamed).toUpdate.length, 1)

  // 期望为空 → delete
  assert.deepEqual(diffReminders(existing, new Map()).toDelete, ['h1'])
})

test('diffReminders：非本插件记录一律不删（宁可留孤儿，不误删用户数据）', () => {
  const foreign = [
    { id: 'x1', title: '用户自建', prompt: '这是用户自己写的提醒', scheduledAt: '2026-11-08T12:00:00.000Z' },
  ]
  const d = diffReminders(foreign, new Map())
  assert.deepEqual(d.toDelete, [], '没有 [[wb:]] 标记的记录不属于本插件')
})

// ---------------------------------------------------------------- 同步器

test('reconcile：首次建齐、再次完全幂等', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const data = {
    tasks: [
      mkTask('t1', 'A', '2026-11-08T12:00:00.000Z'),
      mkTask('t2', 'B', '2026-11-09T12:00:00.000Z'),
    ],
  }

  const r1 = await sync.reconcile('s1', data)
  assert.equal(r1.created, 2)
  assert.equal(r1.updated, 0)
  assert.equal(r1.failed.length, 0)

  const r2 = await sync.reconcile('s1', data)
  assert.equal(r2.created, 0, '重复对齐不得重复注册')
  assert.equal(r2.updated, 0, '同数据不得产生 update')
  assert.equal(r2.unchanged, 2)
  assert.equal(sched.rows.size, 2)
})

test('reconcile：改期只 update 那一条，其余进 unchanged', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', {
    tasks: [
      mkTask('t1', 'A', '2026-11-08T12:00:00.000Z'),
      mkTask('t2', 'B', '2026-11-09T12:00:00.000Z'),
    ],
  })
  const r = await sync.reconcile('s1', {
    tasks: [
      mkTask('t1', 'A', '2026-11-10T12:00:00.000Z'),
      mkTask('t2', 'B', '2026-11-09T12:00:00.000Z'),
    ],
  })
  assert.equal(r.updated, 1)
  assert.equal(r.unchanged, 1)
  assert.equal(r.created, 0)
})

test('reconcile：删掉实体 → 对应提醒被删', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', {
    tasks: [
      mkTask('t1', 'A', '2026-11-08T12:00:00.000Z'),
      mkTask('t2', 'B', '2026-11-09T12:00:00.000Z'),
    ],
  })
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  assert.equal(r.deleted, 1)
  assert.equal(sched.rows.size, 1)
})

test('reconcile：已完成/软删会撤销提醒（不是留着不响）', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  assert.equal(sched.rows.size, 1)

  const r = await sync.reconcile('s1', {
    tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z', { done: true })],
  })
  assert.equal(r.deleted, 1, '完成待办必须取消其提醒')
  assert.equal(sched.rows.size, 0)
})

test('reconcile：catalog 不可用时**不写任何东西**（避免重复注册）', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  sched.failCatalog(true)

  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  assert.equal(r.catalogAvailable, false)
  assert.equal(r.created, 0, '读不到现状就写 = 重复注册风险')
  assert.equal(sched.calls.create.length, 0)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].stage, 'catalog')
})

test('reconcile：非法 dueAt 进 problems，不中断其余提醒', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', {
    tasks: [
      mkTask('t1', '合法', '2026-11-08T12:00:00.000Z'),
      mkTask('t2', '坏数据', '排序验证'),
    ],
  })
  assert.equal(r.created, 1, '坏数据不得拖垮整批')
  assert.deepEqual(r.problems, [{ entityId: 't2', reason: 'invalid-dueAt' }])
  assert.equal(sched.rows.size, 1)
})

test('reconcile：单条 create 失败不中断整批，且失败被上报', async () => {
  const sched = fakeSchedule()
  const realCreate = sched.create.bind(sched)
  let nth = 0
  sched.create = async (sid, req) => {
    nth += 1
    if (nth === 1) throw Object.assign(new Error('boom'), { code: 'invalid_prompt' })
    return realCreate(sid, req)
  }
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', {
    tasks: [
      mkTask('t1', 'A', '2026-11-08T12:00:00.000Z'),
      mkTask('t2', 'B', '2026-11-09T12:00:00.000Z'),
    ],
  })
  assert.equal(r.created, 1)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].stage, 'create')
})

test('reconcile：缺 sessionId 直接失败，不猜一个', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  for (const bad of ['', null, undefined]) {
    const r = await sync.reconcile(bad, { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
    assert.equal(r.created, 0)
    assert.equal(r.failed[0].reason, 'missing-sessionId')
  }
})

test('reconcile：update 失败不改数据，且进 failed', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  sched.update = async () => { throw Object.assign(new Error('conflict'), { code: 'schedule_conflict' }) }
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-10T12:00:00.000Z')] })
  assert.equal(r.updated, 0)
  assert.equal(r.failed[0].stage, 'update')
})

// ---------------------------------------------------------------- 投递状态

test('deliveryStateOf：三态显式，不把「查不到」当「没投递」', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })

  // 后端没有 history
  const noHist = createReminderSync({ schedule: { catalog: async () => [] }, now: () => NOW })
  assert.equal((await noHist.deliveryStateOf('s1', 'x')).state, 'unknown')

  // 正常空历史 → undelivered
  assert.equal((await sync.deliveryStateOf('s1', 'x')).state, 'undelivered')

  // 有记录 → delivered
  sched.history = async () => ({ id: 'x', records: [{ at: '2026-11-07T00:00:00Z' }] })
  assert.equal((await sync.deliveryStateOf('s1', 'x')).state, 'delivered')

  // 更早记录被裁掉 → unknown，不能推断成「没投递过」
  sched.history = async () => ({ id: 'x', records: [], earlierRecordsUnavailable: true })
  const pruned = await sync.deliveryStateOf('s1', 'x')
  assert.equal(pruned.state, 'unknown')
  assert.equal(pruned.reason, 'history-pruned')

  // history 抛错 → unknown
  sched.history = async () => { throw Object.assign(new Error('io'), { code: 'storage-unavailable' }) }
  assert.equal((await sync.deliveryStateOf('s1', 'x')).state, 'unknown')
})

test('recordOf：剥掉 catalog 投影字段，只留纯 ScheduleRecord', () => {
  const entry = {
    id: 'x', kind: 'at', title: 'A', prompt: 'p', scheduledAt: '2026-11-08T12:00:00.000Z',
    sessionId: 's1', status: 'active', lastDelivery: { at: 'x' },
  }
  const rec = recordOf(entry)
  assert.equal(rec.sessionId, undefined, 'sessionId 是 catalog 投影，不属于 record')
  assert.equal(rec.status, undefined)
  assert.equal(rec.lastDelivery, undefined)
  assert.equal(rec.id, 'x')
  assert.equal(rec.scheduledAt, '2026-11-08T12:00:00.000Z')
})

test('desiredFrom：task 与 event 同时参与，身份不串', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const { desired, problems } = sync.desiredFrom({
    tasks: [mkTask('t1', '待办', '2026-11-08T12:00:00.000Z')],
    events: [mkEvent('e1', '日程', '2026-11-09T09:00:00')],
  })
  assert.equal(problems.length, 0)
  assert.deepEqual([...desired.keys()].sort(),
    [reminderIdentity('event-start', 'e1'), reminderIdentity('task', 't1')].sort())
})

// ---------------------------------------------------------------- X10 补测

test('X10：已完成待办必须撤销提醒（写进策略，不只在推导层过滤）', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const future = '2026-11-08T12:00:00.000Z'

  // 建：未完成 → 有提醒
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', future)] })
  assert.equal(sched.rows.size, 1)

  // 完成 → 提醒必须被删，而不只是「不再新建」
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', future, { done: true })] })
  assert.equal(r.deleted, 1, '完成待办必须触发取消')
  assert.equal(sched.rows.size, 0, 'Host 上不得残留已完成待办的提醒')

  // 取消完成 → 提醒重新建回来
  const r2 = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', future)] })
  assert.equal(r2.created, 1, '重新打开待办必须恢复提醒')
  assert.equal(sched.rows.size, 1)
})

test('X10：软删待办同样撤销提醒', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const future = '2026-11-08T12:00:00.000Z'
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', future)] })
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', future, { deleted: true })] })
  assert.equal(r.deleted, 1)
  assert.equal(sched.rows.size, 0)
})

// ================================================ 审查 P0 回归（对抗性审查补充）

test('P0-1：不得跨 session 删除别人的提醒（catalog 是全表）', async () => {
  const sched = fakeSchedule()
  // session-B 已有一条本插件提醒
  await sched.create('session-B', {
    title: 'B 的提醒',
    prompt: encodePrompt('B 正文', reminderIdentity('task', 'tb')),
    at: '2026-11-10T12:00:00.000Z',
  })
  const bRow = [...sched.rows.values()][0]

  // session-A 对账，期望集合里没有 B 的东西
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('session-A', { tasks: [] })

  assert.equal(r.deleted, 0, 'A 不得报告「删掉了 B 的提醒」')
  assert.equal(sched.rows.has(bRow.id), true, 'B 的提醒必须还在')
  assert.equal(r.failed.length, 0, '也不该报成失败——根本不该去碰它')
})

test('P0-1：delete 返回 deleted:false 时必须计入 failed，不得谎报成功', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  const before = [...sched.rows.values()][0]

  // 强行让 delete 返回 deleted:false（模拟 Host 守卫拦截）
  sched.delete = async (req) => ({ id: req.id, deleted: false, code: 'schedule_not_found' })

  const r = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r.deleted, 0, '没删掉就不能计成功')
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].stage, 'delete')
  assert.equal(r.failed[0].reason, 'schedule_not_found')
  assert.equal(sched.rows.has(before.id), true)
})

test('P0-1：update 返回 updated:false 时必须计入 failed', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })

  sched.update = async (req) => ({ id: req.id, updated: false, code: 'schedule_conflict' })
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-10T12:00:00.000Z')] })
  assert.equal(r.updated, 0)
  assert.equal(r.failed[0].stage, 'update')
  assert.equal(r.failed[0].reason, 'schedule_conflict')
})

test('P0-2：超长正文截断后，身份标记仍必须完整保留', () => {
  const longBody = 'x'.repeat(3000)
  const encoded = encodePrompt(longBody, reminderIdentity('task','t1'))
  assert.ok(encoded.length <= MAX_REMINDER_PROMPT, '长度仍受控')
  assert.equal(identityOfHostRecord({ prompt: encoded }), reminderIdentity('task','t1'),
    '截断只能截正文，标记必须保留 —— 否则该记录永远认不出、永远删不掉')
  assert.ok(encoded.includes('[[wb:'), '标记左半可见')
  assert.ok(encoded.trimEnd().endsWith(']]'), '标记右半可见')
})

test('P0-2：正文正好等于预算时必须原样保留，不被误截', () => {
  const tagLen = ` ${IDENTITY_MARK_OPEN}${reminderIdentity('task','t1')}]]`.length
  const body = 'y'.repeat(MAX_REMINDER_PROMPT - tagLen)
  const encoded = encodePrompt(body, reminderIdentity('task','t1'))
  assert.equal(encoded.length, MAX_REMINDER_PROMPT)
  assert.equal(identityOfHostRecord({ prompt: encoded }), reminderIdentity('task','t1'))
})

test('P0-3：用户手写的纯文本标记不被认领（必须带不可见前缀）', () => {
  // 自然打字出来的（无零宽前缀）→ 不认领，避免误删用户自建提醒
  assert.equal(identityOfHostRecord({ prompt: '我的提醒 [[wb:task:victim]]' }), null)
  // 本插件写的（带前缀）→ 认领
  assert.equal(identityOfHostRecord({ prompt: encodePrompt('x', reminderIdentity('task','t1')) }), reminderIdentity('task','t1'))
})

test('P0-4：不同 scope 的同一实体互不覆盖', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  const rA = await sync.reconcile('s1', data, 'projA')
  const rB = await sync.reconcile('s1', data, 'projB')
  assert.equal(rA.created, 1)
  assert.equal(rB.created, 1, '不同 scope 应各自建一条，而不是 update 掉对方')
  assert.equal(sched.rows.size, 2, '两个 scope 的提醒必须共存')

  // 再各跑一次，必须都是幂等
  const rA2 = await sync.reconcile('s1', data, 'projA')
  const rB2 = await sync.reconcile('s1', data, 'projB')
  assert.equal(rA2.unchanged, 1)
  assert.equal(rB2.unchanged, 1)
  assert.equal(sched.rows.size, 2)
})

// ============================== WP5.2：身份标记只做识别，不做认证

test('WP5.2：ownershipOf 分级 —— 只有自洽的才允许删', () => {
  const owned = encodePrompt('x', reminderIdentity('task', 't1'))
  const otherScope = encodePrompt('x', reminderIdentity('task', 't1', 'projB'))
  const otherKind = encodePrompt('x', reminderIdentity('event-start', 't1'))

  // 自洽 → owned
  assert.equal(ownershipOf({ prompt: owned }, { scope: '' }).level, 'owned')
  // 别的 scope → suspect（保留）
  assert.equal(ownershipOf({ prompt: otherScope }, { scope: '' }).level, 'suspect')
  // 别的 kind → suspect
  assert.equal(ownershipOf({ prompt: otherKind, kind: 'at' }, { scope: '', kind: 'task' }).level, 'suspect')
  // 无标记 → foreign
  assert.equal(ownershipOf({ prompt: '用户自己的提醒' }, { scope: '' }).level, 'foreign')
  // 伪造：带不可见前缀但身份格式错 → suspect（不删）
  const forged = `\u200B\u2060[[wb:乱码]]`
  assert.equal(ownershipOf({ prompt: forged }, { scope: '' }).level, 'suspect')
})

test('WP5.2：用户伪造带标记的提醒，不得被删除（宁可留孤儿）', async () => {
  const sched = fakeSchedule()
  // 用户自己在 schedule 里建的提醒，正文照抄了标记格式
  await sched.create('s1', {
    title: '我的自定义提醒',
    prompt: '\u200B\u2060[[wb:task:_:victim]]',
    at: '2026-11-20T10:00:00.000Z',
  })
  const mine = [...sched.rows.values()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // 期望集合里没有任何 task:victim
  const r = await sync.reconcile('s1', { tasks: [] })

  /**
   * 这条记录解出来是 `task:_:victim`，与本次 scope('') 自洽 → 会被判 owned
   * 并删除。这正是「不可见字符不是认证」要处理的情况：
   * 我们无法区分「本插件写的」与「用户照抄的」。
   *
   * 因此策略是：**只有当 identity 对应的实体在我们这轮数据里「曾经存在过」
   * 才允许删**。这里数据是空的，victim 从未存在 → 不得删。
   */
  assert.equal(sched.rows.has(mine.id), true, '无法确认归属时不得删除')
  assert.equal(r.deleted, 0)
})

test('WP5.2：确属我们的（实体曾存在）才允许删除', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })

  // 第一轮：实体存在 → 建提醒（这证明该 identity 确实是我们的）
  await sync.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  assert.equal(sched.rows.size, 1)

  // 第二轮：实体消失 → 允许删（因为上一轮它确属我们）
  const r = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r.deleted, 1, '确认过归属的才删')
  assert.equal(sched.rows.size, 0)
})

test('WP5.2：别的 scope 的记录不被本 scope 删除', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  await sync.reconcile('s1', data, 'projA')
  const aRow = [...sched.rows.values()][0]

  // projB 对账，看到 projA 的记录：identity 的 scope 不匹配 → suspect → 不删
  const r = await sync.reconcile('s1', { tasks: [] }, 'projB')
  assert.equal(r.deleted, 0, 'projB 不得删 projA 的提醒')
  assert.equal(sched.rows.has(aRow.id), true)
})

test('WP5.2：删除的唯一依据是「本同步器创建过」，不是标记本身', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })

  // 三种记录都带完美自洽的标记，但都不是本同步器建的
  await sched.create('s1', { title: 'A', prompt: encodePrompt('x', reminderIdentity('task', 'a')), at: '2026-11-20T10:00:00.000Z' })
  await sched.create('s1', { title: 'B', prompt: encodePrompt('x', reminderIdentity('task', 'b')), at: '2026-11-20T11:00:00.000Z' })
  const ids = [...sched.rows.keys()]
  assert.equal(ids.length, 2)

  const r = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r.deleted, 0, '从未创建过的，标记再像也不许删')
  assert.equal(r.kept.length, 2, '必须如实报告「保留了几条」')
  assert.equal(sched.rows.size, 2)

  // report.kept 要能定位到具体记录
  for (const k of r.kept) {
    assert.ok(typeof k.id === 'string')
    assert.equal(k.reason, 'never-created-by-us')
  }
})

test('WP5.2：只有「创建过 + 现在不再需要」才删，删后白名单同步清理', async () => {
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  await sync.reconcile('s1', data)
  assert.equal(sched.rows.size, 1)

  // 再跑一次幂等：不应删
  const r2 = await sync.reconcile('s1', data)
  assert.equal(r2.deleted, 0)
  assert.equal(r2.kept.length, 0, '自己的记录不该进 kept')

  // 实体消失 → 允许删
  const r3 = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r3.deleted, 1)
  assert.equal(sched.rows.size, 0)

  // 删掉后再跑，不得因为「记得"过但已删」而报错或重复删
  const r4 = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r4.deleted, 0)
  assert.equal(r4.kept.length, 0)
})

test('WP5.2：白名单必须跨进程存活（否则重启后永远清不掉孤儿）', async () => {
  // 用一个共享的「磁盘」
  const disk = new Map()
  const ownershipFor = (sessionId, scope) => ({
    load: () => disk.get(`${sessionId}|${scope}`) ?? [],
    save: (ids) => { disk.set(`${sessionId}|${scope}`, [...ids]) },
  })

  // 进程 1：建一条
  const sched1 = fakeSchedule()
  const sync1 = createReminderSync({ schedule: sched1, now: () => NOW, ownershipFor })
  await sync1.reconcile('s1', { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] })
  assert.equal(sched1.rows.size, 1)
  assert.deepEqual(disk.get('s1|'), [reminderIdentity('task','t1')], '创建必须落盘')

  // 进程 2：全新实例，读同一份磁盘 —— 必须认得这条是自己的
  const sched2 = fakeSchedule()
  for (const row of sched1.rows.values()) sched2.rows.set(row.id, { ...row })
  const sync2 = createReminderSync({ schedule: sched2, now: () => NOW, ownershipFor })
  const r = await sync2.reconcile('s1', { tasks: [] })
  assert.equal(r.deleted, 1, '重启后仍能清理（否则孤儿只增不减）')
  assert.equal(sched2.rows.size, 0)
  assert.deepEqual(disk.get('s1|'), [], '删除后白名单同步清空')
})

test('WP5.2：加载失败时退化为空集 = 少删，不得多删', async () => {
  const badFor = () => ({
    load: () => { throw new Error('disk on fire') },
    save: () => { throw new Error('disk on fire') },
  })
  const sched = fakeSchedule()
  await sched.create('s1', { title: 'A', prompt: encodePrompt('x', reminderIdentity('task','t1')), at: '2026-11-20T10:00:00.000Z' })
  const id = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor: badFor })
  const r = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r.deleted, 0, '读不到白名单时不能删')
  assert.equal(sched.rows.has(id), true)
  assert.equal(r.kept.length, 1)
})

test('WP5.2：不同 scope 的白名单互不共享（A 的授权不能给 B 用）', async () => {
  const disk = new Map()
  const ownershipFor = (sid, scope) => ({
    load: () => disk.get(`${sid}|${scope}`) ?? [],
    save: (ids) => { disk.set(`${sid}|${scope}`, [...ids]) },
  })
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  await sync.reconcile('s1', data, 'projA')
  assert.deepEqual(disk.get('s1|projA'), [reminderIdentity('task','t1','projA')])
  assert.equal(disk.get('s1|projB'), undefined, 'B 不该有 A 的记录')

  // projB 对空数据对账：不得删除 A 的
  const r = await sync.reconcile('s1', { tasks: [] }, 'projB')
  assert.equal(r.deleted, 0)
  assert.equal(sched.rows.size, 1)
})

// ================================ WP5.2 变异真空补齐

test('WP5.2/Z2：同一 identity 名跨不同 scope 时白名单互不授权', async () => {
  /**
   * Z2 变异把 ownershipCache 的 key 改成全局常量。若两个 scope 用**相同**
   * identity 字符串，全局 key 会让它们共享同一份白名单 → 越权授权。
   * 用真实 reconcile 走两个 scope，identity 不同（含 scope 段），
   * 所以这里额外断言：缓存 key 必须带 session 与 scope 两个维度。
   */
  const disk = new Map()
  const ownershipFor = (sid, scope) => ({
    load: () => disk.get(`${sid}|${scope}`) ?? [],
    save: (ids) => { disk.set(`${sid}|${scope}`, [...ids]) },
  })
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  await sync.reconcile('sessA', data, 'sc')
  assert.ok(disk.has('sessA|sc'), '必须按 session+scope 落盘')
  assert.equal(disk.has('sessB|sc'), false, '不该给别的 session 落盘')

  // sessB 同 scope 对空数据：不得因为共享缓存而删 sessA 的提醒
  const r = await sync.reconcile('sessB', { tasks: [] }, 'sc')
  assert.equal(r.deleted, 0, '不同 session 不得借用彼此的删除授权')
  assert.equal(sched.rows.size, 1)
})

test('WP5.2/Z4：读失败时白名单为空集，不得信任任何记录', async () => {
  /**
   * Z4 变异让读失败后 `has()` 恒真 —— 会把用户自建的带标记提醒全删掉。
   * 正确行为是：读失败 → 空集 → 全部 kept。
   */
  const badFor = () => ({
    load: () => { throw new Error('disk on fire') },
    save: () => {},
  })
  const sched = fakeSchedule()
  await sched.create('s1', { title: '用户自建', prompt: encodePrompt('x', reminderIdentity('task', 'victim')), at: '2026-11-20T10:00:00.000Z' })
  const id = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor: badFor })
  const r = await sync.reconcile('s1', { tasks: [] })
  assert.equal(r.deleted, 0, '读失败绝不能变成「全部可删」')
  assert.equal(sched.rows.has(id), true)
  assert.equal(r.kept.length, 1)
})

test('WP5.2/Y15：跨 session 的记录不进入本 session 的 diff', async () => {
  /**
   * Y15 变异去掉 `row.sessionId !== sessionId` 过滤。
   * 此时 B 的记录会进入 A 的 diff，被判为「不在期望集合」。
   * 白名单会拦住删除（纵深防御），但仍会进 `kept` 并被尝试删除 ——
   * 用 delete 调用次数来断言：正确实现下**一次都不该调**。
   */
  const sched = fakeSchedule()
  await sched.create('session-B', {
    title: 'B 的提醒',
    prompt: encodePrompt('B 正文', reminderIdentity('task', 'tb')),
    at: '2026-11-10T12:00:00.000Z',
  })
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('session-A', { tasks: [] })

  assert.equal(sched.calls.delete.length, 0,
    'A 根本不该对 B 的记录发起 delete 调用（不只是删不掉）')
  assert.equal(r.kept.length, 0, '也不该把 B 的记录列进 kept')
  assert.equal(r.deleted, 0)
})

test('WP5.2/Z2-b：同一 session 下不同 scope 不得共享白名单（真正暴露全局 key）', async () => {
  /**
   * Z2 变异把 ownershipCache 的 key 改成常量 `'global'`。
   * 上面那条 Z2 测试被 sessionId 过滤挡住了，这里用**同一 session**、
   * 不同 scope 来真正暴露问题：
   *
   *   scope A 建一条 → 白名单有 `task:projA:t1`
   *   scope B 对空数据 → 若 key 是全局，会命中 A 的 entry（白名单非空）
   *   但 B 的 catalog 里那条记录 identity 是 `task:projA:t1`，
   *   与 B 的 scope 不自洽 → ownershipOf 判 suspect → 不进 diff（还是挡住）
   *
   * 所以改用**直接断言落盘 key 的维度**：两个 scope 必须各自产生独立文件，
   * 且各自的 `save` 收到的内容互不混淆。全局 key 会让第二轮的 save
   * 覆盖到第一轮的 store 上 —— 这是可观测的。
   */
  const disk = new Map()
  const saves = []
  const ownershipFor = (sid, scope) => ({
    load: () => disk.get(`${sid}|${scope}`) ?? [],
    save: (ids) => {
      saves.push({ sid, scope, ids: [...ids] })
      disk.set(`${sid}|${scope}`, [...ids])
    },
  })
  const sched = fakeSchedule()
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  await sync.reconcile('s1', data, 'projA')
  await sync.reconcile('s1', data, 'projB')

  // 两次创建必须分别写到各自的 store，且内容不同
  const a = saves.find((s) => s.scope === 'projA')
  const b = saves.find((s) => s.scope === 'projB')
  assert.ok(a !== undefined, 'projA 必须落盘')
  assert.ok(b !== undefined, 'projB 必须落盘')
  assert.deepEqual(a.ids, [reminderIdentity('task','t1','projA')])
  assert.deepEqual(b.ids, [reminderIdentity('task','t1','projB')], '两个 scope 的 identity 不得混在一起')
  assert.equal(disk.get('s1|projA').length, 1)
  assert.equal(disk.get('s1|projB').length, 1)
})

test('WP5.2/审查8：被安全排除的记录必须上报（不静默）', async () => {
  const sched = fakeSchedule()
  // 一条无标记的（foreign）、一条标记格式非法的（suspect）
  await sched.create('s1', { title: '用户自建', prompt: '普通提醒', at: '2026-11-20T10:00:00.000Z' })
  await sched.create('s1', { title: '可疑', prompt: '\u200B\u2060[[wb:乱码]]', at: '2026-11-21T10:00:00.000Z' })

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [] })

  assert.equal(r.deleted, 0, '一律不删')
  assert.equal(sched.rows.size, 2)
  // 但必须看得见「有两条被刻意保留」
  const levels = r.observed.map((o) => o.level).sort()
  assert.deepEqual(levels, ['foreign', 'suspect'],
    'foreign 与 suspect 都要出现在 observed，不能静默丢弃')
  for (const o of r.observed) {
    assert.ok(typeof o.id === 'string')
    assert.ok(typeof o.reason === 'string' || o.reason === null)
  }
})

// ================================ WP5.2-P0：身份编码与重复投递修复

test('WP5.2-P0：含冒号/Unicode/特殊字符的 scope 必须编码解码完全一致', () => {
  const scopes = ['', '_', 'projA', 'a::b', 'proj:sub', 'x:y:z', '中文:作用域',
    'with space', 'dots.in.scope', 'emoji🙂', 'a.b::c', 'tab\there', ']]', '[[wb:', 'a/b?c#d%d']
  const entityIds = ['t1', 'a::b', 'id:with:colons', '中文id', 'x.y', 'a]]b', 'e/1?2#3', '']
  for (const sc of scopes) {
    for (const eid of entityIds) {
      if (eid === '') continue // 空 entityId 不属于合法输入
      const id = reminderIdentity('task', eid, sc)
      const d = decodeIdentity(id)
      assert.ok(d !== null, `必须可解 scope=${JSON.stringify(sc)} id=${JSON.stringify(eid)}`)
      assert.equal(d.kind, 'task')
      assert.equal(d.scope, sc, `scope 往返失败 ${JSON.stringify(sc)}`)
      assert.equal(d.entityId, eid, `entityId 往返失败 ${JSON.stringify(eid)}`)
      assert.notEqual(d.legacyAmbiguous, true, 'v2 不得标记歧义')
    }
  }
})

test('WP5.2-P0：空 scope 与真实 scope "_" 必须产生不同身份（旧格式在此撞车）', () => {
  const a = reminderIdentity('task', 't1', '')
  const b = reminderIdentity('task', 't1', '_')
  assert.notEqual(a, b, '空 scope 与 "_" 必须可区分')
  assert.equal(decodeIdentity(a).scope, '')
  assert.equal(decodeIdentity(b).scope, '_')
})

test('WP5.2-P0：身份必须带版本标识，且段数固定', () => {
  const id = reminderIdentity('task', 't1', 'a::b')
  assert.ok(id.startsWith(`${IDENTITY_FORMAT_V2}.`), `必须带版本前缀，实际 ${id}`)
  assert.equal(id.split('.').length, 4, '段数固定为 4（base64url 不含 .）')
})

test('WP5.2-P0：含冒号 scope 连续 reconcile 不得重复 create（核心回归）', async () => {
  for (const scope of ['a::b', 'proj:sub', 'x:y:z', '中文:作用域', '']) {
    const sched = fakeSchedule()
    const sync = createReminderSync({ schedule: sched, now: () => NOW })
    const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

    const r1 = await sync.reconcile('s1', data, scope)
    const r2 = await sync.reconcile('s1', data, scope)
    const r3 = await sync.reconcile('s1', data, scope)

    assert.equal(r1.created, 1, `scope=${JSON.stringify(scope)} 首次应建 1 条`)
    assert.equal(sched.calls.create.length, 1,
      `scope=${JSON.stringify(scope)} 三次 reconcile 只能 create 1 次（否则重复投递）`)
    assert.equal(sched.rows.size, 1, `scope=${JSON.stringify(scope)} Host 只能有 1 条 active`)
    assert.equal(r2.unchanged, 1)
    assert.equal(r3.unchanged, 1)
  }
})

test('WP5.2-P0：跨进程重启后身份仍一致，不重复创建', async () => {
  const disk = new Map()
  const ownershipFor = (sid, sc) => ({
    load: () => disk.get(`${sid}|${sc}`) ?? [],
    save: (ids) => disk.set(`${sid}|${sc}`, [...ids]),
  })
  const scope = 'a::b'
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }

  const s1 = fakeSchedule()
  const sync1 = createReminderSync({ schedule: s1, now: () => NOW, ownershipFor })
  await sync1.reconcile('s1', data, scope)
  assert.equal(s1.rows.size, 1)
  assert.deepEqual(disk.get(`s1|${scope}`), [reminderIdentity('task', 't1', scope)])

  // 新实例模拟重启：共享磁盘 + 共享 Host 数据
  const s2 = fakeSchedule()
  for (const row of s1.rows.values()) s2.rows.set(row.id, { ...row })
  const sync2 = createReminderSync({ schedule: s2, now: () => NOW, ownershipFor })
  const r2 = await sync2.reconcile('s1', data, scope)
  assert.equal(r2.created, 0, '重启后不得重复创建')
  assert.equal(r2.unchanged, 1)
  assert.equal(s2.rows.size, 1, 'Host 上仍只有 1 条')
})

test('WP5.2-P0：v1 坏记录无法确认归属时，一律不删、不反复创建（保守，B1 回归）', async () => {
  const sched = fakeSchedule()
  // v1 旧格式，scope 含冒号 → 边界已丢失
  await sched.create('s1', {
    title: '旧提醒',
    prompt: '正文 \u200B\u2060[[wb:task:a::b:t1]]',
    at: '2026-11-08T12:00:00.000Z',
  })
  const oldId = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const data = { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }
  const r = await sync.reconcile('s1', data, 'a::b')

  // 归属无法确认 → 绝不删（B1：迁移通道曾被误删，已移除）
  assert.equal(sched.rows.has(oldId), true, '旧记录必须保留')
  assert.equal(r.created, 1, '本轮仍会建 v2 新记录')
  const r2 = await sync.reconcile('s1', data, 'a::b')
  assert.equal(r2.created, 0, 'v2 幂等：不因旧记录存在而反复创建')
  assert.equal(sched.rows.size, 2, 'Host 上为「1 条旧 v1 + 1 条 v2」')
})

test('WP5.2-P0/B1：跨 scope 的 v1 旧记录绝不能被删（迁移通道已移除的回归）', async () => {
  const sched = fakeSchedule()
  // 空 scope 时代的 v1 两段记录 task:t1（这是 B1 的误删目标）
  await sched.create('s1', {
    title: '空scope旧记录',
    prompt: '正文 \u200B\u2060[[wb:task:t1]]',
    at: '2026-11-08T12:00:00.000Z',
  })
  const oldId = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  // 在 scope=projA 下 reconcile，数据里恰有 t1
  const r = await sync.reconcile('s1',
    { tasks: [mkTask('t1', 'A', '2026-11-08T12:00:00.000Z')] }, 'projA')

  assert.equal(sched.rows.has(oldId), true,
    'B1 回归：projA 的 reconcile 绝不得删空 scope 的 v1 旧记录')
  assert.equal(sched.calls.delete.filter((d) => d.id === oldId).length, 0,
    '对旧记录不得发起任何 delete 调用')
  assert.equal(r.created, 1)
})

test('WP5.2-P0：ownershipOf 必须把 v1 歧义记录判 suspect（否则旧坏记录会被当 owned 误删）', () => {
  // v1 三段 + `_` 占位（歧义）
  assert.equal(ownershipOf({ prompt: '\u200B\u2060[[wb:task:_:t1]]' }, { scope: '' }).level, 'suspect')
  // v1 两段（歧义）
  assert.equal(ownershipOf({ prompt: '\u200B\u2060[[wb:task:t1]]' }, { scope: '' }).level, 'suspect')
  // v1 三段但 id 含冒号（歧义）
  assert.equal(ownershipOf({ prompt: '\u200B\u2060[[wb:task:projA:a:b]]' }, { scope: 'projA' }).level, 'suspect')
  // 理由必须是 legacy-identity-ambiguous，便于上层识别
  const own = ownershipOf({ prompt: '\u200B\u2060[[wb:task:_:t1]]' }, { scope: '' })
  assert.equal(own.reason, 'legacy-identity-ambiguous')
  // 对照：v2 干净身份必须判 owned（不能被上面误伤）
  assert.equal(ownershipOf({ prompt: encodePrompt('x', reminderIdentity('task', 't1')) }, { scope: '' }).level, 'owned')
})

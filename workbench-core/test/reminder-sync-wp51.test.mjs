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
  IDENTITY_MARK_OPEN,
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

test('reminderIdentity：身份含类型 + scope + id，不含时间与标题', () => {
  // 空 scope 用 '_' 占位，避免与真实 scope 值歧义
  assert.equal(reminderIdentity('task', 't1'), 'task:_:t1')
  assert.equal(reminderIdentity('event-start', 'e1'), 'event-start:_:e1')
  // 带 scope：不同 scope 必须算出不同身份（审查 P0-4）
  assert.equal(reminderIdentity('task', 't1', 'projA'), 'task:projA:t1')
  assert.notEqual(reminderIdentity('task', 't1', 'projA'), reminderIdentity('task', 't1', 'projB'))
  assert.notEqual(reminderIdentity('task', 't1', 'projA'), reminderIdentity('task', 't1'))
  // 同一实体的身份恒定 —— 改期/改标题只走 update，不换身份
  assert.equal(reminderIdentity('task', 't1', 's'), reminderIdentity('task', 't1', 's'))
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
  const encoded = encodePrompt('正文', 'task:t1')
  assert.equal(identityOfHostRecord({ prompt: encoded }), 'task:t1')
  // 非本插件写入的记录（无标记）必须返回 null，绝不误删
  assert.equal(identityOfHostRecord({ prompt: '用户自己建的提醒' }), null)
  assert.equal(identityOfHostRecord({}), null)
  assert.equal(identityOfHostRecord(null), null)
  // 标记必须在**结尾**才算，正文中间出现同样字样不算
  assert.equal(identityOfHostRecord({ prompt: '[[wb:task:t9]] 后面的正文' }), null)
})

test('decodeIdentity：能解出类型、scope 与实体 id（兼容旧两段格式）', () => {
  assert.deepEqual(decodeIdentity('task:_:t1'), { kind: 'task', scope: '', entityId: 't1' })
  assert.deepEqual(decodeIdentity('task:projA:t1'), { kind: 'task', scope: 'projA', entityId: 't1' })
  assert.deepEqual(decodeIdentity('event-start:_:e1'), { kind: 'event-start', scope: '', entityId: 'e1' })
  // 旧格式（无 scope）仍能解，scope 视为空
  assert.deepEqual(decodeIdentity('task:t1'), { kind: 'task', scope: '', entityId: 't1' })
  assert.equal(decodeIdentity('nonsense'), null)
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
  const existing = [{
    id: 'h1',
    title: 'A',
    prompt: encodePrompt('待办「A」到期了。', 'task:t1'),
    scheduledAt: '2026-11-08T12:00:00.000Z',
  }]
  const same = new Map([['task:t1', {
    identity: 'task:t1', title: 'A', prompt: '待办「A」到期了。',
    fireAtMs: Date.parse('2026-11-08T12:00:00.000Z'),
  }]])
  const d1 = diffReminders(existing, same)
  assert.equal(d1.toUpdate.length, 0)
  assert.equal(d1.toCreate.length, 0)
  assert.equal(d1.toDelete.length, 0)
  assert.deepEqual(d1.unchanged, ['task:t1'])

  // **W52 锁**：比较基准必须是**编码后**的 prompt。
  //
  // 实测修复前（拿 want.prompt 直接比），同一份数据每次 reconcile 都被判成
  // 「需要更新」：R2/R3 恒为 updated:2，幂等彻底失效。
  // 这里的判据是反向的：Host 上已有的就是编码后的文本，因此**必须判为未变化**。
  const d2 = diffReminders([{ ...existing[0], prompt: encodePrompt('待办「A」到期了。', 'task:t1') }], same)
  assert.equal(d2.toUpdate.length, 0, '编码后的 prompt 与自身相等 → 不得 update')
  assert.deepEqual(d2.unchanged, ['task:t1'])

  // 而正文真的变了，仍然要 update（否则修幂等就修成了「永不更新」）
  const d3 = diffReminders([{ ...existing[0], prompt: encodePrompt('正文已改', 'task:t1') }], same)
  assert.equal(d3.toUpdate.length, 1, '正文变化必须 update')

  // 改期 → update
  const moved = new Map([['task:t1', { ...same.get('task:t1'), fireAtMs: Date.parse('2026-11-09T12:00:00.000Z') }]])
  assert.equal(diffReminders(existing, moved).toUpdate.length, 1)

  // 改标题 → update
  const renamed = new Map([['task:t1', { ...same.get('task:t1'), title: 'A2' }]])
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
  assert.deepEqual([...desired.keys()].sort(), ['event-start:_:e1', 'task:_:t1'])
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
    prompt: encodePrompt('B 正文', 'task:_:tb'),
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
  const encoded = encodePrompt(longBody, 'task:_:t1')
  assert.ok(encoded.length <= MAX_REMINDER_PROMPT, '长度仍受控')
  assert.equal(identityOfHostRecord({ prompt: encoded }), 'task:_:t1',
    '截断只能截正文，标记必须保留 —— 否则该记录永远认不出、永远删不掉')
  assert.ok(encoded.includes('[[wb:'), '标记左半可见')
  assert.ok(encoded.trimEnd().endsWith(']]'), '标记右半可见')
})

test('P0-2：正文正好等于预算时必须原样保留，不被误截', () => {
  const tagLen = ` ${IDENTITY_MARK_OPEN}task:_:t1]]`.length
  const body = 'y'.repeat(MAX_REMINDER_PROMPT - tagLen)
  const encoded = encodePrompt(body, 'task:_:t1')
  assert.equal(encoded.length, MAX_REMINDER_PROMPT)
  assert.equal(identityOfHostRecord({ prompt: encoded }), 'task:_:t1')
})

test('P0-3：用户手写的纯文本标记不被认领（必须带不可见前缀）', () => {
  // 自然打字出来的（无零宽前缀）→ 不认领，避免误删用户自建提醒
  assert.equal(identityOfHostRecord({ prompt: '我的提醒 [[wb:task:victim]]' }), null)
  // 本插件写的（带前缀）→ 认领
  assert.equal(identityOfHostRecord({ prompt: encodePrompt('x', 'task:_:t1') }), 'task:_:t1')
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

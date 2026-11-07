/**
 * WP5.2 最终独立 Review · Agent A 探针
 *
 * 作用域：所有权白名单 / 误删保护 / 持久化恢复
 * 运行：node probe-ownership.mjs > probe-ownership.log 2>&1
 *
 * **只读**：所有 import 来自冻结副本 `/tmp/wp52-freeze-e9b2b32`，
 * 不修改任何业务代码。探针只用内存 fake schedule 驱动同步器。
 */
import {
  createReminderSync,
  ownershipOf,
  encodePrompt,
  identityOfHostRecord,
  decodeIdentity,
  MAX_REMINDER_PROMPT,
} from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/reminder-sync.js'

const LINE = '='.repeat(70)
const say = (s) => console.log(s)
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; say(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; say(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 与真 Host 守卫一致的内存 schedule。 */
function fakeSchedule() {
  const rows = new Map()
  let seq = 0
  const calls = { create: [], update: [], delete: [], catalog: 0 }
  return {
    calls,
    rows,
    async create(sid, req) {
      calls.create.push({ sid, req })
      const id = `schedule-fake-${++seq}`
      const row = {
        id, kind: 'at', title: req.title, prompt: req.prompt,
        scheduledAt: new Date(Date.parse(req.at)).toISOString(),
        sessionId: sid, status: 'active',
      }
      rows.set(id, row)
      return row
    },
    async catalog() { calls.catalog += 1; return [...rows.values()] },
    async update(req) {
      calls.update.push(req)
      const r = rows.get(req.id)
      if (r === undefined) return { id: req.id, updated: false, code: 'schedule_not_found' }
      if (r.sessionId !== req.sessionId) return { id: req.id, updated: false, code: 'schedule_not_found' }
      if (req.expected?.id !== undefined && req.expected.id !== r.id) {
        return { id: req.id, updated: false, code: 'schedule_conflict' }
      }
      if (req.title !== undefined) r.title = req.title
      if (req.prompt !== undefined) r.prompt = req.prompt
      if (req.change !== undefined) r.scheduledAt = new Date(Date.parse(req.change.at)).toISOString()
      return { id: req.id, updated: true, record: { id: r.id, kind: r.kind, title: r.title, prompt: r.prompt, scheduledAt: r.scheduledAt } }
    },
    async delete(req) {
      calls.delete.push(req)
      const r = rows.get(req.id)
      if (r === undefined) return { id: req.id, deleted: false, code: 'schedule_not_found' }
      if (r.sessionId !== req.sessionId) return { id: req.id, deleted: false, code: 'schedule_not_found' }
      rows.delete(req.id)
      return { id: req.id, deleted: true }
    },
    async history() { return { records: [], earlierRecordsUnavailable: false } },
  }
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const mkTask = (id, title, dueAt, extra = {}) => ({ id, title, dueAt, done: false, status: 'planned', ...extra })
const FUTURE = '2026-12-01T10:00:00.000Z'

// ---------------------------------------------------------------- A1 伪造
say(LINE)
say('A1 · 用户伪造完全合法的标记，能否导致误删？')
say(LINE)
{
  const sched = fakeSchedule()
  // 用户写出含不可见前缀、scope 自洽、格式完全合法的标记
  const forged = encodePrompt('这是用户自己的提醒', 'task:_:victim')
  say('  伪造 prompt 尾部: ' + JSON.stringify(forged.slice(-30)))
  const own = ownershipOf({ prompt: forged }, { scope: '' })
  say('  ownershipOf 分级: ' + own.level + ' / identity=' + own.identity)
  check('A1.1 伪造标记被判 owned（说明标记确实不能单独当认证）', own.level === 'owned')

  await sched.create('s1', { title: '用户自建', prompt: forged, at: FUTURE })
  const id = [...sched.rows.keys()][0]

  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [] })
  say('  reconcile: deleted=' + r.deleted + ' kept=' + r.kept.length
    + ' observed=' + r.observed.length + ' failed=' + r.failed.length)
  check('A1.2 伪造记录未被删除', sched.rows.has(id) === true)
  check('A1.3 deleted 计数为 0', r.deleted === 0)
  check('A1.4 kept 如实记录 1 条', r.kept.length === 1)
  check('A1.5 一次 delete 都没发起', sched.calls.delete.length === 0)
  check('A1.6 kept.reason 指明 never-created-by-us',
    r.kept[0]?.reason === 'never-created-by-us', JSON.stringify(r.kept[0]))
}

// ---------------------------------------------------------------- A2 分级
say('')
say(LINE)
say('A2 · ownershipOf 三级分级与 observed 上报')
say(LINE)
{
  const foreign = { prompt: '普通提醒，没有标记' }
  const suspect = { prompt: '\u200B\u2060[[wb:乱码]]' }
  const otherScope = { prompt: encodePrompt('x', 'task:projB:t1') }
  const owned = { prompt: encodePrompt('x', 'task:_:t1') }

  check('A2.1 无标记 → foreign', ownershipOf(foreign, { scope: '' }).level === 'foreign')
  check('A2.2 标记格式非法 → suspect', ownershipOf(suspect, { scope: '' }).level === 'suspect')
  check('A2.3 别的 scope → suspect', ownershipOf(otherScope, { scope: '' }).level === 'suspect')
  check('A2.4 自洽 → owned', ownershipOf(owned, { scope: '' }).level === 'owned')

  const sched = fakeSchedule()
  await sched.create('s1', { title: 'foreign', prompt: '普通提醒', at: FUTURE })
  await sched.create('s1', { title: 'suspect', prompt: '\u200B\u2060[[wb:乱码]]', at: FUTURE })
  const sync = createReminderSync({ schedule: sched, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [] })
  check('A2.5 两条都保留', sched.rows.size === 2)
  check('A2.6 deleted=0', r.deleted === 0)
  const levels = r.observed.map((o) => o.level).sort()
  check('A2.7 observed 含 foreign 与 suspect（不静默）',
    JSON.stringify(levels) === JSON.stringify(['foreign', 'suspect']), JSON.stringify(levels))
}

// ---------------------------------------------------------------- A3 落盘失败
say('')
say(LINE)
say('A3 · 白名单落盘失败 / 读失败 / 文件被删')
say(LINE)
{
  // 3a: save 抛错
  const disk = new Map()
  const forFail = (sid, scope) => ({
    load: () => disk.get(`${sid}|${scope}`) ?? [],
    save: () => { throw new Error('disk full') },
  })
  const s1 = fakeSchedule()
  const sync1 = createReminderSync({ schedule: s1, now: () => NOW, ownershipFor: forFail })
  const r1 = await sync1.reconcile('s1', { tasks: [mkTask('t1', 'A', FUTURE)] })
  check('A3.1 save 失败不阻塞 create', r1.created === 1 && s1.rows.size === 1)
  // 同进程内再次对齐：仍幂等（内存白名单还在）
  const r1b = await sync1.reconcile('s1', { tasks: [mkTask('t1', 'A', FUTURE)] })
  check('A3.2 save 失败后同进程仍幂等', r1b.created === 0 && r1b.unchanged === 1)

  // 3b: load 抛错 → 必须「少删」
  const forBadLoad = () => ({
    load: () => { throw new Error('disk on fire') },
    save: () => {},
  })
  const s2 = fakeSchedule()
  await s2.create('s1', { title: '伪造', prompt: encodePrompt('x', 'task:_:victim'), at: FUTURE })
  const id2 = [...s2.rows.keys()][0]
  const sync2 = createReminderSync({ schedule: s2, now: () => NOW, ownershipFor: forBadLoad })
  const r2 = await sync2.reconcile('s1', { tasks: [] })
  check('A3.3 load 失败时 deleted=0（少删，绝不多删）', r2.deleted === 0)
  check('A3.4 load 失败时记录仍在', s2.rows.has(id2) === true)
  check('A3.5 load 失败进 kept', r2.kept.length === 1)

  // 3c: 故意让 load 返回通配符全集也不该放行（若实现用 has 精确匹配）
  const forWildcard = () => ({ load: () => ['*'], save: () => {} })
  const s3 = fakeSchedule()
  await s3.create('s1', { title: '伪造', prompt: encodePrompt('x', 'task:_:victim'), at: FUTURE })
  const sync3 = createReminderSync({ schedule: s3, now: () => NOW, ownershipFor: forWildcard })
  const r3 = await sync3.reconcile('s1', { tasks: [] })
  check('A3.6 白名单里只有 "*" 不能授权删真实 identity', r3.deleted === 0 && s3.rows.size === 1)
}

// ---------------------------------------------------------------- A4 持久化恢复
say('')
say(LINE)
say('A4 · 跨进程恢复与 scope 隔离')
say(LINE)
{
  const disk = new Map()
  const ownershipFor = (sid, scope) => ({
    load: () => disk.get(`${sid}|${scope}`) ?? [],
    save: (ids) => { disk.set(`${sid}|${scope}`, [...ids]) },
  })

  // 进程 1
  const s1 = fakeSchedule()
  const sync1 = createReminderSync({ schedule: s1, now: () => NOW, ownershipFor })
  await sync1.reconcile('s1', { tasks: [mkTask('t1', 'A', FUTURE)] })
  say('  落盘: ' + JSON.stringify(disk.get('s1|')))
  check('A4.1 创建后白名单落盘', JSON.stringify(disk.get('s1|')) === JSON.stringify(['task:_:t1']))

  // 进程 2：全新实例，共享磁盘 + 共享 catalog 内容
  const s2 = fakeSchedule()
  for (const row of s1.rows.values()) s2.rows.set(row.id, { ...row })
  const sync2 = createReminderSync({ schedule: s2, now: () => NOW, ownershipFor })
  const r2 = await sync2.reconcile('s1', { tasks: [] })
  check('A4.2 重启后仍能清理（不是永不清理）', r2.deleted === 1 && s2.rows.size === 0)
  check('A4.3 删除后白名单同步清空', JSON.stringify(disk.get('s1|')) === '[]')

  // scope 隔离
  const s3 = fakeSchedule()
  const sync3 = createReminderSync({ schedule: s3, now: () => NOW, ownershipFor })
  const data = { tasks: [mkTask('t1', 'A', FUTURE)] }
  await sync3.reconcile('s1', data, 'projA')
  await sync3.reconcile('s1', data, 'projB')
  check('A4.4 两个 scope 分别落盘', disk.has('s1|projA') === true && disk.has('s1|projB') === true)
  check('A4.5 两个 scope 的 identity 不混',
    JSON.stringify(disk.get('s1|projA')) !== JSON.stringify(disk.get('s1|projB')),
    JSON.stringify([disk.get('s1|projA'), disk.get('s1|projB')]))
  const rB = await sync3.reconcile('s1', { tasks: [] }, 'projB')
  /**
   * 正确预期（终审诊断修正）：
   *  - projB 有资格删**自己**创建的 f2（task:projB:t1）→ deleted=1
   *  - projA 的 f1（task:projA:t1）被判 suspect/scope-mismatch → 进 observed，
   *    **绝不能删** → 最终 catalog 必须剩 1 条
   * 原断言写成 `deleted===0` 是探针自身的错误预期，不是产品缺陷。
   */
  const remaining = [...s3.rows.values()]
  check('A4.6 projB 只删自己那条，projA 的提醒保留',
    rB.deleted === 1 && remaining.length === 1
      && remaining[0].prompt.includes('task:projA:t1'),
    `deleted=${rB.deleted} 剩余=${remaining.map(r => r.title).join(',')}`)
  check('A4.7 projA 的记录被判 suspect 并如实上报',
    rB.observed.some(o => o.level === 'suspect' && o.reason === 'scope-mismatch'),
    JSON.stringify(rB.observed))
}

// ---------------------------------------------------------------- A5 截断与格式演进
say('')
say(LINE)
say('A5 · encodePrompt 截断与 identity 格式演进')
say(LINE)
{
  const longBody = 'x'.repeat(3000)
  const enc = encodePrompt(longBody, 'task:_:t1')
  check('A5.1 超长正文截断后身份标记仍完整',
    identityOfHostRecord({ prompt: enc }) === 'task:_:t1')
  check('A5.2 长度仍受控', enc.length <= MAX_REMINDER_PROMPT, String(enc.length))
  check('A5.3 decodeIdentity 兼容旧两段格式',
    JSON.stringify(decodeIdentity('task:t1')) === JSON.stringify({ kind: 'task', scope: '', entityId: 't1' }))
  const oldFmt = { prompt: '正文 [[wb:task:t1]]' }
  check('A5.4 WP5.1 旧格式（无前缀）判 foreign → 保留孤儿（已披露取舍）',
    ownershipOf(oldFmt, { scope: '' }).level === 'foreign')
}

say('')
say(LINE)
say(`Agent A 探针汇总: PASS=${pass} FAIL=${fail}`)
say(LINE)
process.exitCode = fail === 0 ? 0 : 1

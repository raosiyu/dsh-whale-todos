import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorkbenchService,
  DANGEROUS_OPS,
  WorkbenchError,
  ERROR_CODES,
  wallToInstant,
} from '../src/index.js'

const mkSvc = (opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-svc-'))
  let n = 0
  const svc = createWorkbenchService({
    dataDir: dir,
    idFactory: () => `id-${++n}`,
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
    ...opts,
  })
  return { svc, dir }
}

/** 走宿主审批门拿 token（测试里用 isolated 签发）。 */
async function tokenFor(svc, op, detail = {}) {
  const res = await svc.requestApproval(op, detail)
  assert.equal(res.approved, true, `审批应通过：${op}`)
  return res.token
}

const at = (wall, tz = 'Asia/Shanghai') => wallToInstant(`${wall}:00`, tz).ms

const timedEvent = (over = {}) => ({
  title: '评审', allDay: false,
  start: '2026-11-05T09:00', end: '2026-11-05T10:00',
  timeZone: 'Asia/Shanghai', ...over,
})

test('服务：未知操作报 unsupported 并列出支持项', () => {
  const { svc } = mkSvc()
  assert.throws(
    () => svc.execute('nope.op', {}),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.UNSUPPORTED,
  )
})

test('服务：创建事件后能列出与取回', () => {
  const { svc } = mkSvc()
  const created = svc.execute('event.create', { event: timedEvent() })
  assert.ok(created.event.id)
  const list = svc.execute('event.list')
  assert.equal(list.length, 1)
  const got = svc.execute('event.get', { id: created.event.id })
  assert.equal(got.title, '评审')
})

test('服务：参数校验在入口统一生效（未知字段被拒）', () => {
  const { svc } = mkSvc()
  assert.throws(
    () => svc.execute('event.create', { event: { ...timedEvent(), evil: 1 } }),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.VALIDATION,
  )
})

test('服务：冲突事件默认拒绝创建，allowOverlap 时放行', () => {
  const { svc } = mkSvc()
  svc.execute('event.create', { event: timedEvent() })
  assert.throws(
    () => svc.execute('event.create', { event: timedEvent({ start: '2026-11-05T09:30', end: '2026-11-05T10:30' }) }),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.CONFLICT,
  )
  const ok = svc.execute('event.create', {
    event: timedEvent({ start: '2026-11-05T09:30', end: '2026-11-05T10:30' }),
    allowOverlap: true,
  })
  assert.ok(ok.event.id)
})

test('服务：删除是危险操作，未确认被拒', async () => {
  const { svc } = mkSvc()
  const { event } = svc.execute('event.create', { event: timedEvent() })
  assert.throws(
    () => svc.execute('event.delete', { id: event.id }),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.CONFIRMATION_REQUIRED,
  )
  const deleted = svc.execute('event.delete', { id: event.id }, { approvalToken: await tokenFor(svc, 'event.delete', { target: event.id }) })
  assert.ok(deleted.deletedAt)
})

test('服务：软删除后 list 不含、includeDeleted 含、可恢复', async () => {
  const { svc } = mkSvc()
  const { event } = svc.execute('event.create', { event: timedEvent() })
  svc.execute('event.delete', { id: event.id }, { approvalToken: await tokenFor(svc, 'event.delete', { target: event.id }) })
  assert.equal(svc.execute('event.list').length, 0)
  assert.equal(svc.execute('event.list', { includeDeleted: true }).length, 1)
  svc.execute('event.restore', { id: event.id })
  assert.equal(svc.execute('event.list').length, 1)
})

test('服务：更新走白名单，不能改 id', () => {
  const { svc } = mkSvc()
  const { event } = svc.execute('event.create', { event: timedEvent() })
  const updated = svc.execute('event.update', { id: event.id, patch: { title: '新标题', id: 'HACK' } })
  assert.equal(updated.event.title, '新标题')
  assert.equal(updated.event.id, event.id)
})

test('服务：批量删除需确认，且逐条生效', async () => {
  const { svc } = mkSvc()
  const a = svc.execute('event.create', { event: timedEvent({ start: '2026-11-05T09:00', end: '2026-11-05T10:00' }) }).event
  const b = svc.execute('event.create', { event: timedEvent({ start: '2026-11-06T09:00', end: '2026-11-06T10:00' }) }).event
  assert.throws(() => svc.execute('event.bulkDelete', { ids: [a.id, b.id] }), /需要宿主审批凭证/)
  const bulkToken = await tokenFor(svc, 'event.bulkDelete', { ids: [a.id, b.id] })
  const r = svc.execute('event.bulkDelete', { ids: [a.id, b.id] }, { approvalToken: bulkToken })
  assert.equal(r.deleted.length, 2)
  assert.equal(svc.execute('event.list').length, 0)
})

test('服务：expand 返回窗口内实例', () => {
  const { svc } = mkSvc()
  svc.execute('event.create', { event: timedEvent({ recurrence: { freq: 'DAILY', count: 3 } }) })
  const inst = svc.execute('event.expand', {
    windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00'),
  })
  assert.equal(inst.length, 3)
})

test('服务：freeSlots 返回可用时段', () => {
  const { svc } = mkSvc()
  svc.execute('event.create', { event: timedEvent() })
  const r = svc.execute('event.freeSlots', {
    windowStart: at('2026-11-05T08:00'), windowEnd: at('2026-11-05T12:00'), minSlotMs: 30 * 60000,
  })
  assert.ok(r.free.length >= 2)
})

test('服务：ICS 预览不写库，确认后才导入', async () => {
  const { svc } = mkSvc()
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:i1', 'SUMMARY:导入会议',
    'DTSTART;TZID=Asia/Shanghai:20261110T090000', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  const preview = svc.execute('event.previewIcs', { text: ics })
  assert.equal(preview.counts.create, 1)
  assert.equal(svc.execute('event.list').length, 0, '预览不得写库')

  assert.throws(() => svc.execute('event.import', { text: ics }), /需要宿主审批凭证/)
  const importToken = await tokenFor(svc, 'event.import', { text: ics })
  const imported = svc.execute('event.import', { text: ics }, { approvalToken: importToken })
  assert.equal(imported.imported, 1)
  assert.equal(svc.execute('event.list').length, 1)
})

test('服务：ICS 含解析错误时中止导入并保持原数据不变', async () => {
  const { svc } = mkSvc()
  svc.execute('event.create', { event: timedEvent() })
  const bad = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'SUMMARY:无时间', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const badToken = await tokenFor(svc, 'event.import', { text: bad })
  assert.throws(() => svc.execute('event.import', { text: bad }, { approvalToken: badToken }), /无法解析/)
  assert.equal(svc.execute('event.list').length, 1, '原数据不得被破坏')
})

test('服务：快照导出→替换→可回滚', async () => {
  const { svc } = mkSvc()
  svc.execute('event.create', { event: timedEvent() })
  const snap = svc.execute('snapshot.export')
  assert.match(snap.text, /dsh-workbench-snapshot/)

  svc.execute('event.create', { event: timedEvent({ start: '2026-11-06T09:00', end: '2026-11-06T10:00' }) })
  assert.equal(svc.execute('event.list').length, 2)

  const preview = svc.execute('snapshot.preview', { text: snap.text })
  assert.equal(preview.events, 1)

  const replaceToken = await tokenFor(svc, 'snapshot.replace', { text: snap.text })
  svc.execute('snapshot.replace', { text: snap.text }, { approvalToken: replaceToken })
  assert.equal(svc.execute('event.list').length, 1, '替换后应为快照里的 1 条')

  // 指纹绑定具体备份名（N4），且必须显式指定
  const preBackups = svc.store.listPreBackups()
  const targetBackup = preBackups[preBackups.length - 1]
  const rbToken = await tokenFor(svc, 'store.rollback', { target: targetBackup })
  const rb = svc.execute('store.rollback', { name: targetBackup }, { approvalToken: rbToken })
  assert.ok(rb.restored)
})

test('服务：快照替换需确认', () => {
  const { svc } = mkSvc()
  const snap = svc.execute('snapshot.export')
  assert.throws(() => svc.execute('snapshot.replace', { text: snap.text }), /需要宿主审批凭证/)
})

test('服务：Task 与 Event 共用入口但集合隔离，不动既有 Task', async () => {
  const { svc } = mkSvc()
  svc.execute('event.create', { event: timedEvent() })
  svc.execute('task.upsert', { task: { id: 't1', title: '既有任务', statusCode: 'todo' } })
  assert.equal(svc.execute('task.list').length, 1)
  assert.equal(svc.execute('event.list').length, 1)
  // 事件操作不影响任务
  const evId = svc.execute('event.list')[0].id
  svc.execute('event.delete', { id: evId }, { approvalToken: await tokenFor(svc, 'event.delete', { target: evId }) })
  assert.equal(svc.execute('task.list').length, 1)
})

test('服务：Task upsert 缺 id 被拒', () => {
  const { svc } = mkSvc()
  assert.throws(() => svc.execute('task.upsert', { task: { title: 'x' } }), /task\.id/)
})

test('服务：审计日志记录每次写操作', () => {
  const { svc } = mkSvc()
  const { event } = svc.execute('event.create', { event: timedEvent() })
  svc.execute('event.update', { id: event.id, patch: { title: 'x' } })
  const audit = svc.execute('store.audit', { entityId: event.id })
  assert.ok(audit.length >= 2)
  assert.ok(audit.some((row) => row.action === 'event.create'))
  assert.ok(audit.some((row) => row.action === 'event.update'))
})

test('服务：DANGEROUS_OPS 覆盖所有需确认操作', () => {
  // N-06 后新增 event.restore / task.upsert：二者都能改数据（撤销软删 / 覆盖任务）
  assert.deepEqual(
    [...DANGEROUS_OPS].sort(),
    [
      'event.bulkDelete', 'event.delete', 'event.import', 'event.restore',
      'snapshot.replace', 'store.rollback', 'task.upsert',
    ].sort(),
  )
})

test('N-05：deny 模式下所有写操作一律拒绝（不只危险清单）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-deny-'))
  try {
    const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'deny' })
    for (const op of ['event.create', 'event.update', 'task.upsert', 'store.backup', 'event.restore']) {
      assert.throws(
        () => svc.execute(op, {}),
        (e) => e instanceof WorkbenchError
          && (e.code === ERROR_CODES.CONFIRMATION_REQUIRED || e.code === ERROR_CODES.VALIDATION),
        `deny 模式下 ${op} 必须被拒`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('服务：持久化——新实例读到同样数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-svc2-'))
  let n = 0
  const mk = () => createWorkbenchService({ dataDir: dir, idFactory: () => `p-${++n}` })
  const s1 = mk()
  s1.execute('event.create', { event: timedEvent() })
  const s2 = mk()
  assert.equal(s2.execute('event.list').length, 1)
})

test('审批门矩阵：所有破坏性操作都必须确认，常规编辑不强制', () => {
  // 破坏性：删除 / 批量 / 导入（覆盖写）/ 快照替换 / 回滚 —— 必须确认
  const destructive = ['event.delete', 'event.bulkDelete', 'event.import', 'snapshot.replace', 'store.rollback']
  // 常规：创建 / 编辑 / 恢复 / 幂等 upsert —— 不强制（可被 UI 二次确认，但服务层不拦）
  const routine = ['event.create', 'event.update', 'event.restore', 'task.upsert', 'store.backup']

  const { svc } = mkSvc()
  const ops = svc.listOps()
  for (const op of [...destructive, ...routine]) {
    assert.ok(ops.includes(op), `${op} 必须存在`)
  }
  // 破坏性操作在未确认时必须被拦（用一个能构造出合法 payload 的场景验证 delete）
  const { event } = svc.execute('event.create', { event: timedEvent() })
  for (const op of destructive) {
    const payload = op === 'event.delete' ? { id: event.id }
      : op === 'event.bulkDelete' ? { ids: [event.id] }
      : op === 'event.import' ? { text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }
      : op === 'snapshot.replace' ? { text: '{}' }
      : { name: 'probe-pre.json' }   // rollback 现在必须显式指定目标
    assert.throws(
      () => svc.execute(op, payload),
      (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.CONFIRMATION_REQUIRED,
      `${op} 无审批凭证时必须拒绝`,
    )
    // 关键安全断言：payload 里塞 confirmed:true 不能绕过审批
    assert.throws(
      () => svc.execute(op, { ...payload, confirmed: true }, { confirmed: true }),
      (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.CONFIRMATION_REQUIRED,
      `${op} 不接受 payload/confirmed 作为授权`,
    )
  }
})

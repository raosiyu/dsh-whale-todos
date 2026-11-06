/**
 * WP5：导入导出（预览分类 / 不支持报告 / 备份 / 失败不破坏数据）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'

function withService(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-imp-'))
  // isolated 模式：凭证仍必须由 gate 签发（审批门没有被绕过），
  // 只是不询问真人 —— host 模式无 answerer 会一律 unavailable，测不到导入路径。
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
  })
  const result = fn(svc, dir)
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(dir, { recursive: true, force: true })
  return result
}

const ICS_HEAD = 'BEGIN:VCALENDAR\nVERSION:2.0\n'
const ICS_TAIL = 'END:VCALENDAR\n'

test('ICS 预览分四类：新增 / 重复 / 冲突 / 不支持', () => withService((svc) => {
  svc.execute('event.create', {
    event: {
      title: '占位', allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:00',
      timeZone: 'Asia/Shanghai', uid: 'uid-existing',
    },
  }, { actor: 'ui' })

  const ics = ICS_HEAD + [
    'BEGIN:VTODO', 'SUMMARY:不该导入', 'END:VTODO',
    'BEGIN:VEVENT', 'UID:uid-existing', 'SUMMARY:重复的', 'DTSTART:20261110T100000', 'TZID:Asia/Shanghai', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:uid-conflict', 'SUMMARY:冲突的', 'DTSTART:20261110T103000', 'DTEND:20261110T113000', 'TZID:Asia/Shanghai', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:uid-fresh', 'SUMMARY:新增的', 'DTSTART:20261112T090000', 'DTEND:20261112T100000', 'TZID:Asia/Shanghai', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:uid-badrrule', 'SUMMARY:坏规则', 'DTSTART:20261113T090000', 'TZID:Asia/Shanghai', 'RRULE:FREQ=BOGUS', 'END:VEVENT',
  ].join('\n') + '\n' + ICS_TAIL

  const preview = svc.execute('event.previewIcs', { text: ics, defaultTimeZone: 'Asia/Shanghai' }, {})
  assert.equal(preview.counts.create, 2, '新增两条（新增的 + 坏规则事件本身有效）')
  assert.equal(preview.counts.duplicate, 1, '重复一条')
  assert.equal(preview.counts.conflict, 1, '冲突一条')
  assert.equal(preview.counts.unsupported, 2, 'VTODO + 坏 RRULE 必须各报一条')
  assert.equal(preview.counts.degraded, 1, '坏 RRULE 的事件被降级，必须可见')

  const kinds = preview.unsupported.map((x) => x.kind).sort()
  assert.deepEqual(kinds, ['component', 'rrule'], '不支持项必须是结构化的，不是自由文本')
  assert.equal(preview.unsupported.find((x) => x.kind === 'component').detail, 'VTODO')

  const conflictRow = preview.plan.find((x) => x.title === '冲突的')
  assert.equal(conflictRow.action, 'conflict')
  assert.equal(conflictRow.conflictWith.length > 0, true, '必须指出与谁冲突')
}))

test('不支持的 ICS 组件不会被静默丢弃（授权硬要求）', () => withService((svc) => {
  const ics = ICS_HEAD + 'BEGIN:VTODO\nSUMMARY:任务\nEND:VTODO\n' + ICS_TAIL
  const preview = svc.execute('event.previewIcs', { text: ics, defaultTimeZone: 'Asia/Shanghai' }, {})
  assert.equal(preview.unsupported.length, 1)
  assert.equal(preview.unsupported[0].kind, 'component')
}))

test('导入前自动备份，导入后可回滚核验', () => withService(async (svc) => {
  const ics = ICS_HEAD + [
    'BEGIN:VEVENT', 'UID:uid-x', 'SUMMARY:导入的', 'DTSTART:20261201T090000', 'DTEND:20261201T100000', 'TZID:Asia/Shanghai', 'END:VEVENT',
  ].join('\n') + '\n' + ICS_TAIL

  const preview = svc.execute('event.previewIcs', { text: ics, defaultTimeZone: 'Asia/Shanghai' }, {})
  const token = await svc.requestApproval('event.import', { text: ics })
  const result = svc.execute('event.import', { text: ics, defaultTimeZone: 'Asia/Shanghai' }, { actor: 'ui', approvalToken: token.token })

  assert.equal(result.imported, 1)
  assert.equal(typeof result.backup.path, 'string', '导入必须留备份')
  assert.equal(svc.execute('event.list', {}, {}).length, 1)
  assert.equal(preview.counts.create, 1)
}))

test('导入失败不破坏既有数据', () => withService(async (svc) => {
  svc.execute('event.create', { event: { title: '既有', allDay: true, startDate: '2026-11-10' } }, { actor: 'ui' })
  const before = svc.execute('event.list', {}, {}).length

  // 含一条坏 DTSTART → errors 非空 → 必须中止
  const ics = ICS_HEAD + [
    'BEGIN:VEVENT', 'UID:uid-good', 'SUMMARY:好的', 'DTSTART:20261201T090000', 'TZID:Asia/Shanghai', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:uid-bad', 'SUMMARY:坏的', 'END:VEVENT',
  ].join('\n') + '\n' + ICS_TAIL
  const token = await svc.requestApproval('event.import', { text: ics })
  assert.throws(
    () => svc.execute('event.import', { text: ics, defaultTimeZone: 'Asia/Shanghai' }, { actor: 'ui', approvalToken: token.token }),
    (e) => e?.code === 'validation',
  )
  assert.equal(svc.execute('event.list', {}, {}).length, before, '失败后既有数据一条不少')
}))

test('JSON 快照预览报告会被移除的条目（覆盖式导入必须可见）', () => withService((svc) => {
  svc.execute('event.create', { event: { title: '会被移除', allDay: true, startDate: '2026-11-10' } }, { actor: 'ui' })
  svc.execute('task.upsert', { task: { id: 't1', title: '保留的', done: false } }, { actor: 'ui' })

  const snapshot = JSON.stringify({
    format: 'dsh-workbench-snapshot', version: 1,
    events: [{ id: 'ev-new', title: '新的', allDay: true, startDate: '2026-12-01' }],
    tasks: [{ id: 't1', title: '保留的', done: true }],
  })
  const preview = svc.execute('snapshot.preview', { text: snapshot }, {})
  assert.equal(preview.counts.create, 1, '一条新增事件')
  assert.equal(preview.counts.duplicate, 1, '一条重复任务')
  assert.equal(preview.counts.removed, 1, '一条既有事件会被覆盖掉')
  assert.equal(preview.removedEvents.length, 1, '必须指名道姓列出')
  assert.equal(preview.removedTasks.length, 0)
}))

test('快照导出 → 预览 → 替换往返一致', () => withService(async (svc) => {
  svc.execute('event.create', { event: { title: '往返', allDay: true, startDate: '2026-11-10' } }, { actor: 'ui' })
  svc.execute('task.upsert', { task: { id: 't1', title: '往返待办', done: false, priority: 'high' } }, { actor: 'ui' })

  const exported = svc.execute('snapshot.export', {}, {})
  const preview = svc.execute('snapshot.preview', { text: exported.text }, {})
  assert.equal(preview.counts.removed, 0, '导出再预览不应丢任何东西')

  const token = await svc.requestApproval('snapshot.replace', { text: exported.text })
  svc.execute('snapshot.replace', { text: exported.text }, { actor: 'ui', approvalToken: token.token })
  const events = svc.execute('event.list', {}, {})
  const tasks = svc.execute('task.list', {}, {})
  assert.equal(events.length, 1)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].priority, 'high', '往返必须保住字段')
}))

test('ICS 导出后再导入：不产生重复', () => withService((svc) => {
  svc.execute('event.create', { event: { title: '导出源', allDay: true, startDate: '2026-11-10' } }, { actor: 'ui' })
  const exported = svc.execute('event.exportIcs', {}, {})
  const preview = svc.execute('event.previewIcs', { text: exported.text, defaultTimeZone: 'Asia/Shanghai' }, {})
  assert.equal(preview.counts.create, 0, '自己导出的不应再算新增')
  assert.equal(preview.counts.duplicate, 1, '应被识别为重复')
}))

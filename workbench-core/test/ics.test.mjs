import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseIcs,
  buildIcs,
  exportJson,
  parseJsonSnapshot,
  validateEventInput,
  normalizeEventInput,
  WorkbenchError,
  ERROR_CODES,
} from '../src/index.js'

const ICS_ONE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:abc-123',
  'SUMMARY:产品评审',
  'DESCRIPTION:第一行\\n第二行',
  'LOCATION:会议室 A',
  'DTSTART;TZID=Asia/Shanghai:20261105T090000',
  'DTEND;TZID=Asia/Shanghai:20261105T100000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const ICS_ALLDAY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'SUMMARY:假期',
  'DTSTART;VALUE=DATE:20261105',
  'DTEND;VALUE=DATE:20261107',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const ICS_RRULE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:rr-1',
  'SUMMARY:周会',
  'DTSTART;TZID=Asia/Shanghai:20261102T090000',
  'DTEND;TZID=Asia/Shanghai:20261102T100000',
  'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=4',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

test('ICS 导入：定时事件字段完整解析', () => {
  const r = parseIcs(ICS_ONE)
  assert.equal(r.events.length, 1)
  const e = r.events[0]
  assert.equal(e.title, '产品评审')
  assert.equal(e.description, '第一行\n第二行')
  assert.equal(e.location, '会议室 A')
  assert.equal(e.allDay, false)
  assert.equal(e.start, '2026-11-05T09:00:00')
  assert.equal(e.end, '2026-11-05T10:00:00')
  assert.equal(e.timeZone, 'Asia/Shanghai')
  assert.equal(e.source, 'ics')
})

test('ICS 导入：VALUE=DATE 识别为全天', () => {
  const r = parseIcs(ICS_ALLDAY)
  const e = r.events[0]
  assert.equal(e.allDay, true)
  assert.equal(e.startDate, '2026-11-05')
  assert.equal(e.endDate, '2026-11-07')
})

test('ICS 导入：RRULE 解析为结构化规则', () => {
  const r = parseIcs(ICS_RRULE)
  const e = r.events[0]
  assert.equal(e.recurrence.freq, 'WEEKLY')
  assert.equal(e.recurrence.interval, 1)
  assert.equal(e.recurrence.count, 4)
  assert.deepEqual(e.recurrence.byDay, ['MO', 'WE'])
})

test('ICS 导入：缺 DTSTART 记 error 而非静默丢弃', () => {
  const bad = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'SUMMARY:无时间', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  const r = parseIcs(bad)
  assert.equal(r.events.length, 0)
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /DTSTART/)
})

test('ICS 导入：缺 VCALENDAR 报错', () => {
  assert.throws(() => parseIcs('BEGIN:VEVENT\r\nEND:VEVENT'), /缺少 BEGIN:VCALENDAR/)
})

test('ICS 导入：空内容报错', () => {
  assert.throws(() => parseIcs('   '), /内容为空/)
})

test('ICS 导入：RECURRENCE-ID 例外实例被跳过并记 warning', () => {
  const withOverride = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:r1', 'SUMMARY:周会',
    'DTSTART;TZID=Asia/Shanghai:20261102T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:r1', 'RECURRENCE-ID:20261109T090000', 'SUMMARY:周会(改期)',
    'DTSTART;TZID=Asia/Shanghai:20261109T140000', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const r = parseIcs(withOverride)
  assert.equal(r.events.length, 1)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /RECURRENCE-ID/)
})

test('ICS 导入：折行（续行）被正确拼接', () => {
  const folded = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:f1',
    'SUMMARY:这是一个很长的标题需要折行处理以确保解析正确',
    ' 续行部分',
    'DTSTART;TZID=Asia/Shanghai:20261105T090000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const r = parseIcs(folded)
  assert.match(r.events[0].title, /续行部分/)
})

test('ICS 导出：定时/全天/重复都能往返', () => {
  const events = [
    normalizeRow(validateEventInput({
      title: '评审', allDay: false, start: '2026-11-05T09:00', end: '2026-11-05T10:00', timeZone: 'Asia/Shanghai',
      recurrence: { freq: 'WEEKLY', byDay: ['MO'], count: 3 },
    }), 'e1'),
    normalizeRow(validateEventInput({ title: '假期', allDay: true, startDate: '2026-11-05', endDate: '2026-11-07' }), 'e2'),
  ]
  const text = buildIcs(events)
  assert.match(text, /BEGIN:VCALENDAR/)
  assert.match(text, /DTSTART;TZID=Asia\/Shanghai:20261105T090000/)
  assert.match(text, /DTSTART;VALUE=DATE:20261105/)
  assert.match(text, /RRULE:FREQ=WEEKLY/)

  const back = parseIcs(text)
  assert.equal(back.events.length, 2)
  const timed = back.events.find((e) => !e.allDay)
  assert.equal(timed.start, '2026-11-05T09:00:00')
  assert.equal(timed.recurrence.freq, 'WEEKLY')
  const allday = back.events.find((e) => e.allDay)
  assert.equal(allday.startDate, '2026-11-05')
  assert.equal(allday.endDate, '2026-11-07')
})

test('ICS 导出：已取消事件不导出', () => {
  const row = normalizeRow(validateEventInput({
    title: 'x', allDay: false, start: '2026-11-05T09:00', timeZone: 'UTC',
  }), 'e1')
  row.status = 'cancelled'
  const text = buildIcs([row])
  assert.equal(/BEGIN:VEVENT/.test(text), false)
})

test('ICS 导出：文本特殊字符被转义且可还原', () => {
  const row = normalizeRow(validateEventInput({
    title: '带,逗号;分号\\反斜杠', description: '多行\n描述',
    allDay: false, start: '2026-11-05T09:00', timeZone: 'UTC',
  }), 'e1')
  const text = buildIcs([row])
  const back = parseIcs(text)
  assert.equal(back.events[0].title, '带,逗号;分号\\反斜杠')
  assert.equal(back.events[0].description, '多行\n描述')
})

test('JSON 快照：导出后解析回来结构一致', () => {
  const snapshot = { events: [{ id: 'e1' }], tasks: [{ id: 't1' }] }
  const text = exportJson(snapshot, { fingerprint: 'abc' })
  const back = parseJsonSnapshot(text)
  assert.equal(back.events.length, 1)
  assert.equal(back.tasks.length, 1)
  assert.equal(JSON.parse(text).fingerprint, 'abc')
})

test('JSON 快照：坏 JSON 报 validation', () => {
  assert.throws(
    () => parseJsonSnapshot('{oops'),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.VALIDATION,
  )
})

test('JSON 快照：不支持的 format 报 unsupported', () => {
  assert.throws(
    () => parseJsonSnapshot(JSON.stringify({ format: 'other', events: [] })),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.UNSUPPORTED,
  )
})

test('JSON 快照：版本过高报 unsupported（不降级猜测）', () => {
  assert.throws(
    () => parseJsonSnapshot(JSON.stringify({ version: 9, events: [] })),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.UNSUPPORTED,
  )
})

test('JSON 快照：events 非数组报错', () => {
  assert.throws(() => parseJsonSnapshot(JSON.stringify({ events: {} })), /events 必须是数组/)
})

function normalizeRow(validated, id) {
  return {
    id,
    uid: id,
    ...normalizeEventInput(validated),
    createdAt: 'x',
    updatedAt: 'x',
    deletedAt: null,
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateEventInput,
  normalizeEventInput,
  validateRecurrence,
  WorkbenchError,
  ERROR_CODES,
  ianaTimeZone,
  isoInstant,
  isoDate,
  validateObject,
  nonEmptyString,
  boolean,
  number,
  oneOf,
  arrayOf,
} from '../src/index.js'

test('事件：非全天必须给 start + timeZone', () => {
  assert.throws(
    () => validateEventInput({ title: 'x', allDay: false, start: '2026-11-05T09:00' }),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.VALIDATION,
  )
})

test('事件：全天必须给 startDate，且不能混用 start/end', () => {
  assert.throws(() => validateEventInput({ title: 'x', allDay: true }), /全天事件必须给 startDate/)
  assert.throws(
    () => validateEventInput({ title: 'x', allDay: true, startDate: '2026-11-05', start: '2026-11-05T09:00' }),
    /全天事件不能给 start\/end/,
  )
})

test('事件：end 必须晚于 start', () => {
  assert.throws(
    () => validateEventInput({
      title: 'x', allDay: false, start: '2026-11-05T10:00', end: '2026-11-05T09:00', timeZone: 'UTC',
    }),
    /end 必须晚于 start/,
  )
})

test('事件：未知字段被拒绝（防越权写 id/createdAt）', () => {
  assert.throws(
    () => validateEventInput({
      title: 'x', allDay: false, start: '2026-11-05T09:00', timeZone: 'UTC', id: 'hack',
    }),
    /未知字段：event\.id/,
  )
})

test('事件：归一化保留全天与定时两种形状，互斥字段置 null', () => {
  const allDay = normalizeEventInput(validateEventInput({
    title: '假期', allDay: true, startDate: '2026-11-05', importance: 'high',
  }))
  assert.equal(allDay.startDate, '2026-11-05')
  assert.equal(allDay.start, null)
  assert.equal(allDay.timeZone, null)
  assert.equal(allDay.importance, 'high')
  assert.equal(allDay.status, 'confirmed')

  const timed = normalizeEventInput(validateEventInput({
    title: '评审', allDay: false, start: '2026-11-05T09:00', timeZone: 'Asia/Shanghai',
  }))
  assert.equal(timed.startDate, null)
  assert.equal(timed.timeZone, 'Asia/Shanghai')
  assert.equal(timed.end, null)
})

test('重复规则：count 与 until 互斥', () => {
  assert.throws(
    () => validateRecurrence({ freq: 'DAILY', count: 3, until: '2026-12-01' }),
    /不能同时出现/,
  )
})

test('重复规则：byDay 仅 WEEKLY 支持', () => {
  assert.throws(() => validateRecurrence({ freq: 'DAILY', byDay: ['MO'] }), /只支持 WEEKLY/)
})

test('重复规则：不支持的 freq 被拒绝并给出可选值', () => {
  assert.throws(() => validateRecurrence({ freq: 'HOURLY' }), /FREQ|必须是以下之一/)
})

test('重复规则：interval 归一为 1，undefined 键被清除', () => {
  const r = validateRecurrence({ freq: 'WEEKLY', byDay: ['MO', 'WE'] })
  assert.equal(r.interval, 1)
  assert.deepEqual(r.byDay, ['MO', 'WE'])
  assert.equal('count' in r, false)
})

test('时区：非法 IANA 名被拒绝', () => {
  assert.throws(() => ianaTimeZone('Mars/Phobos', 'tz'), /不是合法 IANA 时区/)
  assert.equal(ianaTimeZone('Asia/Shanghai', 'tz'), 'Asia/Shanghai')
})

test('isoInstant：无时区被拒绝，带时区归一为 UTC', () => {
  assert.throws(() => isoInstant('2026-11-05T09:00:00', 'at'), /必须带时区/)
  assert.equal(isoInstant('2026-11-05T09:00:00+08:00', 'at'), '2026-11-05T01:00:00.000Z')
})

test('isoDate：拒绝不存在的日期', () => {
  assert.throws(() => isoDate('2026-02-30', 'd'), /不是真实存在的日期/)
  assert.equal(isoDate('2026-02-28', 'd'), '2026-02-28')
})

test('validateObject：缺字段/未知字段都给出字段路径', () => {
  const spec = { a: nonEmptyString, b: boolean, c: number({ min: 1 }), d: oneOf(['x', 'y']), e: arrayOf(nonEmptyString) }
  assert.throws(() => validateObject(spec, {}), /缺少必填字段：a/)
  assert.throws(
    () => validateObject(spec, { a: 'ok', b: true, c: 2, d: 'x', e: ['z'], extra: 1 }),
    /未知字段：extra/,
  )
  const out = validateObject(spec, { a: 'ok', b: true, c: 2, d: 'x', e: ['z'] })
  assert.deepEqual(out.e, ['z'])
})

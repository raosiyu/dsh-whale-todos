import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateEventInput,
  normalizeEventInput,
  expandEvent,
  expandEvents,
  wallToInstant,
  instantToWall,
  addDaysToDate,
  MAX_OCCURRENCES,
  WorkbenchError,
  ERROR_CODES,
} from '../src/index.js'

let seq = 0
const mkId = () => `evt-${++seq}`

function timed(over = {}) {
  const input = validateEventInput({
    title: '评审',
    allDay: false,
    start: '2026-11-05T09:00',
    end: '2026-11-05T10:00',
    timeZone: 'Asia/Shanghai',
    ...over,
  })
  return { id: mkId(), uid: 'uid-' + seq, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null }
}

function allDay(over = {}) {
  const input = validateEventInput({ title: '假期', allDay: true, startDate: '2026-11-05', ...over })
  return { id: mkId(), uid: 'uid-' + seq, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null }
}

const dayMs = 86400000
const at = (wall, tz = 'Asia/Shanghai') => wallToInstant(`${wall}:00`, tz).ms

test('时区：Asia/Shanghai 无 DST，09:00 对应 UTC 01:00', () => {
  assert.equal(instantToWall(at('2026-11-05T09:00'), 'UTC'), '2026-11-05T01:00:00')
})

test('DST：America/New_York 春季前跳——不存在的墙钟被前移到空档结束', () => {
  // 2026-03-08 02:30 在纽约不存在（02:00 → 03:00）
  const r = wallToInstant('2026-03-08T02:30:00', 'America/New_York')
  assert.equal(r.adjusted, 'gap')
  const back = instantToWall(r.ms, 'America/New_York')
  assert.equal(back, '2026-03-08T03:30:00')
})

test('DST：America/New_York 秋季回拨——重复墙钟取较早瞬间', () => {
  // 2026-11-01 01:30 出现两次
  const r = wallToInstant('2026-11-01T01:30:00', 'America/New_York')
  assert.equal(r.adjusted, 'overlap')
  const earlier = wallToInstant('2026-11-01T00:30:00', 'America/New_York').ms
  assert.ok(r.ms > earlier)
  assert.equal(instantToWall(r.ms, 'America/New_York'), '2026-11-01T01:30:00')
})

test('重复：DAILY count=3 只产出 3 次', () => {
  const ev = timed({ recurrence: { freq: 'DAILY', count: 3 } })
  const out = expandEvent(ev, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') })
  assert.equal(out.length, 3)
  assert.deepEqual(
    out.map((o) => instantToWall(o.startMs, 'Asia/Shanghai').slice(0, 10)),
    ['2026-11-05', '2026-11-06', '2026-11-07'],
  )
})

test('重复：WEEKLY byDay=MO,WE 每周两次', () => {
  const ev = timed({ start: '2026-11-02T09:00', end: '2026-11-02T10:00', recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'] } })
  const out = expandEvent(ev, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-16T00:00') })
  const dates = out.map((o) => instantToWall(o.startMs, 'Asia/Shanghai').slice(0, 10))
  assert.deepEqual(dates, ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11'])
})

test('重复：UNTIL 收口（日期按当天 23:59:59 含当天）', () => {
  const ev = timed({ recurrence: { freq: 'DAILY', until: '2026-11-07' } })
  const out = expandEvent(ev, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-12-01T00:00') })
  assert.equal(out.length, 3)
})

test('重复：MONTHLY 31 号—RFC 策略跳过 2 月（非法日期 MUST be ignored）', () => {
  const ev = timed({
    start: '2026-01-31T09:00', end: '2026-01-31T10:00',
    recurrence: { freq: 'MONTHLY', count: 4 },
  })
  const out = expandEvent(ev, {
    windowStart: at('2026-01-01T00:00'), windowEnd: Date.UTC(2027, 5, 1), monthEndPolicy: 'rfc',
  })
  const dates = out.map((o) => instantToWall(o.startMs, 'UTC').slice(0, 10))
  // 2 月没有 31 日 → 该实例被忽略，且不占 COUNT 名额
  assert.deepEqual(dates, ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'])
})

test('重复：MONTHLY 31 号—clamp 策略收敛到月末（本项目扩展，非 RFC）', () => {
  const ev = timed({
    start: '2026-01-31T09:00', end: '2026-01-31T10:00',
    recurrence: { freq: 'MONTHLY', count: 4 },
  })
  const out = expandEvent(ev, {
    windowStart: at('2026-01-01T00:00'), windowEnd: Date.UTC(2027, 5, 1), monthEndPolicy: 'clamp',
  })
  const dates = out.map((o) => instantToWall(o.startMs, 'UTC').slice(0, 10))
  assert.deepEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
})

test('重复：非法 monthEndPolicy 被拒绝', () => {
  const ev = timed({ recurrence: { freq: 'MONTHLY', count: 2 } })
  assert.throws(
    () => expandEvent(ev, { windowStart: at('2026-01-01T00:00'), windowEnd: Date.UTC(2027, 0, 1), monthEndPolicy: 'nope' }),
    /monthEndPolicy/,
  )
})

test('重复：窗口裁剪——只返回与窗口相交的实例', () => {
  const ev = timed({ recurrence: { freq: 'DAILY' } })
  const out = expandEvent(ev, { windowStart: at('2026-11-10T00:00'), windowEnd: at('2026-11-13T00:00') })
  assert.equal(out.length, 3)
})

test('重复：非重复事件落在窗口外返回空', () => {
  const ev = timed()
  const out = expandEvent(ev, { windowStart: at('2027-01-01T00:00'), windowEnd: at('2027-02-01T00:00') })
  assert.deepEqual(out, [])
})

test('重复：已取消事件不参与展开', () => {
  const ev = { ...timed(), status: 'cancelled' }
  const out = expandEvents([ev], { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') })
  assert.deepEqual(out, [])
})

test('重复：不支持的字段显式报 unsupported（不静默忽略）', () => {
  const ev = timed()
  ev.recurrence = { freq: 'DAILY', interval: 1, bySetPos: 1 }
  assert.throws(
    () => expandEvent(ev, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') }),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.UNSUPPORTED,
  )
})

test('重复：无限规则 + 超大窗口触发上限保护，不 OOM', () => {
  const ev = timed({ recurrence: { freq: 'DAILY' } })
  assert.throws(
    () => expandEvent(ev, { windowStart: at('2026-01-01T00:00'), windowEnd: at('2036-01-01T00:00') }),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.UNSUPPORTED,
  )
  assert.ok(MAX_OCCURRENCES > 0)
})

test('重复：展开窗口非法时拒绝', () => {
  const ev = timed()
  assert.throws(
    () => expandEvent(ev, { windowStart: 100, windowEnd: 100 }),
    /窗口非法/,
  )
})

test('重复：全天事件按 UTC 日界展开，startDate 透出', () => {
  const ev = allDay({ recurrence: { freq: 'DAILY', count: 2 } })
  const out = expandEvent(ev, { windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1) })
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((o) => o.startDate), ['2026-11-05', '2026-11-06'])
  assert.ok(out.every((o) => o.allDay === true))
})

test('日期工具：addDaysToDate 跨月跨年正确', () => {
  assert.equal(addDaysToDate('2026-12-31', 1), '2027-01-01')
  assert.equal(addDaysToDate('2026-02-28', 1), '2026-03-01')
  assert.equal(addDaysToDate('2026-03-01', -1), '2026-02-28')
})

test('重复：interval=2 的 DAILY 隔天一次', () => {
  const ev = timed({ recurrence: { freq: 'DAILY', interval: 2, count: 3 } })
  const out = expandEvent(ev, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') })
  const dates = out.map((o) => instantToWall(o.startMs, 'Asia/Shanghai').slice(0, 10))
  assert.deepEqual(dates, ['2026-11-05', '2026-11-07', '2026-11-09'])
})

test('重复：YEARLY 闰日—RFC 策略跳过平年 2/29', () => {
  const ev = timed({
    start: '2024-02-29T09:00', end: '2024-02-29T10:00',
    recurrence: { freq: 'YEARLY', count: 2 },
  })
  const out = expandEvent(ev, {
    windowStart: at('2024-01-01T00:00'), windowEnd: at('2029-12-31T00:00'), monthEndPolicy: 'rfc',
  })
  const dates = out.map((o) => instantToWall(o.startMs, 'UTC').slice(0, 10))
  // 2025/2026/2027 无 2/29 → 跳过；下一个合法是 2028
  assert.deepEqual(dates, ['2024-02-29', '2028-02-29'])
})

test('重复：YEARLY 闰日—clamp 策略收敛到 2/28', () => {
  const ev = timed({
    start: '2024-02-29T09:00', end: '2024-02-29T10:00',
    recurrence: { freq: 'YEARLY', count: 2 },
  })
  const out = expandEvent(ev, {
    windowStart: at('2024-01-01T00:00'), windowEnd: at('2029-12-31T00:00'), monthEndPolicy: 'clamp',
  })
  const dates = out.map((o) => instantToWall(o.startMs, 'UTC').slice(0, 10))
  assert.deepEqual(dates, ['2024-02-29', '2025-02-28'])
})

test('全天事件：锚定自身 timeZone，在上海时区读作 00:00 而不是 08:00', () => {
  const ev = allDay({ timeZone: 'Asia/Shanghai' })
  const out = expandEvent(ev, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') })
  assert.equal(out.length, 1)
  assert.equal(instantToWall(out[0].startMs, 'Asia/Shanghai'), '2026-11-05T00:00:00')
  assert.equal(instantToWall(out[0].endMs, 'Asia/Shanghai'), '2026-11-06T00:00:00')
})

test('全天事件：未指定 timeZone 时按 UTC 锚定（跨时区仍读作同一本地日）', () => {
  const ev = allDay()
  const out = expandEvent(ev, { windowStart: Date.UTC(2026, 10, 1), windowEnd: Date.UTC(2026, 11, 1) })
  assert.equal(instantToWall(out[0].startMs, 'UTC'), '2026-11-05T00:00:00')
})

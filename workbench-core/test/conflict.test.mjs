import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  findConflicts,
  findFreeSlots,
  checkEventConflicts,
  validateEventInput,
  normalizeEventInput,
  expandEvents,
  wallToInstant,
} from '../src/index.js'

let seq = 0
const mkId = () => `c-${++seq}`
const at = (wall, tz = 'Asia/Shanghai') => wallToInstant(`${wall}:00`, tz).ms

function timed(start, end, over = {}) {
  const input = validateEventInput({
    title: `t${seq}`, allDay: false, start, end, timeZone: 'Asia/Shanghai', ...over,
  })
  return { id: mkId(), uid: `u-${seq}`, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null }
}

function allDayEvent(startDate, over = {}) {
  const input = validateEventInput({ title: `a${seq}`, allDay: true, startDate, ...over })
  return { id: mkId(), uid: `u-${seq}`, ...normalizeEventInput(input), createdAt: 'x', updatedAt: 'x', deletedAt: null }
}

const win = { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-12-01T00:00') }

test('冲突：重叠的定时事件被检出', () => {
  const a = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const b = timed('2026-11-05T09:30', '2026-11-05T10:30')
  const inst = expandEvents([a, b], win)
  const conflicts = findConflicts(inst)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].overlapMs, 30 * 60000)
})

test('冲突：首尾相接不算冲突（半开区间）', () => {
  const a = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const b = timed('2026-11-05T10:00', '2026-11-05T11:00')
  const inst = expandEvents([a, b], win)
  assert.deepEqual(findConflicts(inst), [])
})

test('冲突：两个全天事件互不冲突', () => {
  const a = allDayEvent('2026-11-05')
  const b = allDayEvent('2026-11-05')
  const inst = expandEvents([a, b], win)
  assert.deepEqual(findConflicts(inst), [])
})

test('冲突：全天与定时默认不冲突，allDayBlocks=true 时才冲突', () => {
  const a = allDayEvent('2026-11-05')
  const b = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const inst = expandEvents([a, b], win)
  assert.deepEqual(findConflicts(inst), [])
  assert.equal(findConflicts(inst, { allDayBlocks: true }).length, 1)
})

test('冲突：重复事件与单次事件交叉命中', () => {
  const daily = timed('2026-11-01T09:00', '2026-11-01T10:00', { recurrence: { freq: 'DAILY' } })
  const once = timed('2026-11-05T09:30', '2026-11-05T10:30')
  const inst = expandEvents([daily, once], win)
  const conflicts = findConflicts(inst)
  assert.equal(conflicts.length, 1)
})

test('冲突：已取消事件不参与', () => {
  const a = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const b = { ...timed('2026-11-05T09:30', '2026-11-05T10:30'), status: 'cancelled' }
  const inst = expandEvents([a, b], win)
  assert.deepEqual(findConflicts(inst), [])
})

test('空闲：两个会议之间留出空档，且 minSlot 过滤过短空档', () => {
  const a = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const b = timed('2026-11-05T11:00', '2026-11-05T12:00')
  const r = findFreeSlots([a, b], {
    windowStart: at('2026-11-05T08:00'), windowEnd: at('2026-11-05T18:00'), minSlotMs: 30 * 60000,
  })
  assert.equal(r.free.length, 3) // 08-09, 10-11, 12-18
  assert.equal(r.busy.length, 2)
})

test('空闲：buffer 把相邻会议的空档吃掉', () => {
  const a = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const b = timed('2026-11-05T10:20', '2026-11-05T11:00')
  const r = findFreeSlots([a, b], {
    windowStart: at('2026-11-05T08:00'), windowEnd: at('2026-11-05T12:00'),
    minSlotMs: 15 * 60000, bufferMs: 15 * 60000,
  })
  const mid = r.free.filter((f) => f.startMs >= at('2026-11-05T10:00') && f.endMs <= at('2026-11-05T10:20'))
  assert.equal(mid.length, 0)
})

test('空闲：全天空档（无事件）返回整个窗口', () => {
  const r = findFreeSlots([], {
    windowStart: at('2026-11-05T09:00'), windowEnd: at('2026-11-05T10:00'), minSlotMs: 60000,
  })
  assert.equal(r.free.length, 1)
  assert.equal(r.free[0].endMs - r.free[0].startMs, 3600000)
})

test('空闲：窗口非法时拒绝', () => {
  assert.throws(() => findFreeSlots([], { windowStart: 100, windowEnd: 50 }), /窗口非法/)
})

test('写入前冲突检查：候选与已有事件冲突时 blocking=true', () => {
  const existing = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const candidate = {
    id: 'cand', uid: 'cand', title: 'x', allDay: false,
    start: '2026-11-05T09:30', end: '2026-11-05T10:30', timeZone: 'Asia/Shanghai',
    recurrence: null, status: 'confirmed', tags: [],
  }
  const r = checkEventConflicts([existing], candidate, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') })
  assert.equal(r.blocking, true)
  assert.equal(r.conflicts.length, 1)
})

test('写入前冲突检查：allowOverlap 时 blocking=false', () => {
  const existing = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const candidate = {
    id: 'cand', uid: 'cand', title: 'x', allDay: false,
    start: '2026-11-05T09:30', end: '2026-11-05T10:30', timeZone: 'Asia/Shanghai',
    recurrence: null, status: 'confirmed', tags: [],
  }
  const r = checkEventConflicts([existing], candidate, {
    windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00'), allowOverlap: true,
  })
  assert.equal(r.blocking, false)
  assert.equal(r.conflicts.length, 1)
})

test('写入前冲突检查：排除自身（更新场景）不与自己冲突', () => {
  const self = timed('2026-11-05T09:00', '2026-11-05T10:00')
  const r = checkEventConflicts([self], self, { windowStart: at('2026-11-01T00:00'), windowEnd: at('2026-11-30T00:00') })
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.blocking, false)
})

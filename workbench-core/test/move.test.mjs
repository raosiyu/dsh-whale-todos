/**
 * WP5：日历拖拽（event.move）语义测试。
 *
 * 核心约束（授权原文）：重复日程必须明确区分「修改单次」与「整个系列」，
 * 未支持的操作明确拒绝 —— 不允许猜。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'
import { MOVABLE_MODES } from '../src/service.js'

const DAY = 86400000
const dayMs = (date) => Date.parse(`${date}T00:00:00Z`)

function withService(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-move-'))
  try {
    return fn(createWorkbenchService({ dataDir: dir, approvalMode: 'host' }), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const expandIn = (svc, from, to) => svc.execute('event.expand', { windowStart: dayMs(from), windowEnd: dayMs(to) }, {})

test('非重复事件移动 = series，且拒绝 single', () => withService((svc) => {
  const created = svc.execute('event.create', {
    event: { title: 'A', allDay: true, startDate: '2026-11-10' },
  }, { actor: 'ui' }).event

  const moved = svc.execute('event.move', {
    id: created.id, mode: 'series', target: { startDate: '2026-11-12' },
  }, { actor: 'ui' })
  assert.equal(moved.event.startDate, '2026-11-12')

  assert.throws(
    () => svc.execute('event.move', {
      id: created.id, mode: 'single', occurrenceDate: '2026-11-12', target: { startDate: '2026-11-13' },
    }, { actor: 'ui' }),
    (e) => e?.code === 'validation',
    '非重复事件没有「只改这一次」语义',
  )
}))

test('「此后所有」明确拒绝，不假装支持', () => withService((svc) => {
  const created = svc.execute('event.create', {
    event: { title: 'A', allDay: true, startDate: '2026-11-10' },
  }, { actor: 'ui' }).event
  assert.throws(
    () => svc.execute('event.move', { id: created.id, mode: 'thisAndFuture', target: { startDate: '2026-11-20' } }, { actor: 'ui' }),
    (e) => e?.code === 'unsupported',
    'thisAndFuture 必须明确拒绝',
  )
  assert.deepEqual([...MOVABLE_MODES], ['single', 'series'])
}))

test('重复事件 series 移动：整体平移（含 excludeDates）', () => withService((svc) => {
  const created = svc.execute('event.create', {
    event: {
      title: 'B', allDay: true, startDate: '2026-11-10',
      recurrence: { freq: 'WEEKLY', interval: 1, count: 3 },
      excludeDates: ['2026-11-17'],
    },
  }, { actor: 'ui' }).event

  const moved = svc.execute('event.move', {
    id: created.id, mode: 'series', target: { startDate: '2026-11-12' },
  }, { actor: 'ui' })
  assert.equal(moved.event.startDate, '2026-11-12')
  assert.deepEqual(moved.event.excludeDates, ['2026-11-19'], '排除日期随系列整体平移')
}))

test('重复事件 single：只改这一次（EXDATE + 独立事件）', () => withService((svc) => {
  const created = svc.execute('event.create', {
    event: {
      title: 'C', allDay: true, startDate: '2026-12-01',
      recurrence: { freq: 'WEEKLY', interval: 1, count: 4 },
    },
  }, { actor: 'ui' }).event

  const before = expandIn(svc, '2026-12-01', '2026-12-31')
  assert.equal(before.length, 4)

  const moved = svc.execute('event.move', {
    id: created.id, mode: 'single', occurrenceDate: '2026-12-08', target: { startDate: '2026-12-10' },
  }, { actor: 'ui' })

  assert.deepEqual(moved.event.excludeDates, ['2026-12-08'], '原实例被排除')
  assert.equal(moved.created.startDate, '2026-12-10', '新独立事件承载新时间')
  assert.equal(moved.created.recurrence, null, '新事件不带重复规则')

  const after = expandIn(svc, '2026-12-01', '2026-12-31')
  assert.equal(after.length, 4, '实例总数不变（没丢也没多）')
  assert.equal(after.some((o) => o.startDate === '2026-12-08'), false, '原日期消失')
  assert.equal(after.some((o) => o.startDate === '2026-12-10'), true, '新日期出现')
  // 系列其余实例完全不动
  assert.deepEqual(
    after.map((o) => o.startDate).filter((d) => d !== '2026-12-10').sort(),
    ['2026-12-01', '2026-12-15', '2026-12-22'],
  )
}))

test('single 只能作用于真实实例（乱给日期必须拒绝）', () => withService((svc) => {
  const created = svc.execute('event.create', {
    event: {
      title: 'D', allDay: true, startDate: '2026-12-01',
      recurrence: { freq: 'WEEKLY', interval: 1, count: 3 },
    },
  }, { actor: 'ui' }).event
  assert.throws(
    () => svc.execute('event.move', {
      id: created.id, mode: 'single', occurrenceDate: '2026-12-03', target: { startDate: '2026-12-04' },
    }, { actor: 'ui' }),
    (e) => e?.code === 'validation',
    '不是该系列的实例，不能「只改这一次」',
  )
}))

test('移动冲突时拒绝，且原位置不变（前端据此恢复）', () => withService((svc) => {
  const a = svc.execute('event.create', {
    event: { title: '占位', allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:00', timeZone: 'Asia/Shanghai' },
  }, { actor: 'ui' }).event
  const b = svc.execute('event.create', {
    event: { title: '待移', allDay: false, start: '2026-11-10T14:00', end: '2026-11-10T15:00', timeZone: 'Asia/Shanghai' },
  }, { actor: 'ui' }).event

  assert.throws(
    () => svc.execute('event.move', {
      id: b.id, mode: 'series', target: { start: '2026-11-10T10:30', timeZone: 'Asia/Shanghai' },
    }, { actor: 'ui' }),
    (e) => e?.code === 'conflict',
    '重叠必须拒绝',
  )
  const still = svc.execute('event.get', { id: b.id }, {})
  assert.equal(still.start, '2026-11-10T14:00', '失败后原位置不变')
  assert.equal(a.id !== b.id, true)
}))

test('全天事件移动：endDate 随 startDate 平移', () => withService((svc) => {
  const created = svc.execute('event.create', {
    event: { title: '差旅', allDay: true, startDate: '2026-11-10', endDate: '2026-11-13' },
  }, { actor: 'ui' }).event
  const moved = svc.execute('event.move', {
    id: created.id, mode: 'series', target: { startDate: '2026-11-17' },
  }, { actor: 'ui' })
  assert.equal(moved.event.startDate, '2026-11-17')
  assert.equal(moved.event.endDate, '2026-11-20', '3 天时长保持不变')
}))

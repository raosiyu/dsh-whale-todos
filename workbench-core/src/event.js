/**
 * Event（日程事件）实体：模型、校验、归一。
 *
 * ## 与 Task 的边界（WP1 的核心设计约束）
 *
 * Task 有 `allDay` / `recurrence*`，但那是**任务属性**：任务是"要做的事"，用截止时间表达。
 * Event 是"要占用的时间段"：有起止、可重复、会互相冲突。两者共享时间语义，
 * **不共享表、不共享生命周期**——Task 完成有验收流程，Event 只是被安排。
 *
 * 因此本文件只定义 Event，不碰 Task；统一入口在 `service.js` 里做门面。
 */

import { arrayOf, boolean, ianaTimeZone, isoInstant, nonEmptyString, number, oneOf, optional, string, validateObject } from './validate.js'
import { wallToInstant, WALL_PATTERN } from './time.js'
import { validationError } from './errors.js'

/** 事件来源：本地手建 / ICS 导入。 */
export const EVENT_SOURCES = Object.freeze(['local', 'ics'])

/** 事件状态：正常 / 已取消（重复事件的单次例外用它表达）。 */
export const EVENT_STATUSES = Object.freeze(['confirmed', 'cancelled'])

/** 重要度（供"重要日程概览"使用）。 */
export const IMPORTANCE_LEVELS = Object.freeze(['low', 'normal', 'high'])

/** 重复规则支持的频率（MVP 子集，明确写清边界，不假装全 RFC5545）。 */
export const RRULE_FREQUENCIES = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

/** 星期代号（RRULE BYDAY 用）。 */
export const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])

const wallClock = (value, path) => {
  const s = string(value, path)
  if (!WALL_PATTERN.test(s)) {
    throw validationError(`${path} 必须是 YYYY-MM-DDTHH:mm[:ss] 墙钟时间`, { path, got: s })
  }
  return s
}

const isoDateString = (value, path) => {
  const s = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw validationError(`${path} 必须是 YYYY-MM-DD`, { path, got: s })
  }
  return s
}

/** RRULE 子集校验：FREQ 必填；INTERVAL/COUNT/UNTIL/BYDAY 可选。 */
export function validateRecurrence(input, path = 'recurrence') {
  const spec = {
    freq: oneOf(RRULE_FREQUENCIES),
    interval: optional(number({ integer: true, min: 1, max: 366 }), 1),
    count: optional(number({ integer: true, min: 1, max: 1000 }), undefined),
    until: optional(string, undefined),
    byDay: optional(arrayOf(oneOf(WEEKDAYS), { min: 1, max: 7 }), undefined),
  }
  const out = validateObject(spec, input, { path })
  if (out.count !== undefined && out.until !== undefined) {
    throw validationError(`${path} 的 count 与 until 不能同时出现（RFC5545 互斥）`, { path })
  }
  if (out.until !== undefined && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/.test(out.until)) {
    throw validationError(`${path}.until 必须是日期或带时区的时间`, { path: `${path}.until`, got: out.until })
  }
  if (out.byDay !== undefined && out.freq !== 'WEEKLY') {
    throw validationError(`${path}.byDay 目前只支持 WEEKLY`, { path: `${path}.byDay`, freq: out.freq })
  }
  // 归一：去掉 undefined 键，便于稳定序列化与比较
  const clean = { freq: out.freq, interval: out.interval }
  if (out.count !== undefined) clean.count = out.count
  if (out.until !== undefined) clean.until = out.until
  if (out.byDay !== undefined) clean.byDay = [...out.byDay]
  return clean
}

const recurrenceValidator = (value, path) => validateRecurrence(value, path)

/**
 * 创建 Event 的输入校验。
 *
 * 两种时间表达二选一：
 * - `allDay: true`  → 必填 `startDate`（YYYY-MM-DD），`endDate` 可选（含端不含，缺省 = startDate + 1 天）
 * - `allDay: false` → 必填 `start`（墙钟）+ `timeZone`，`end`（墙钟）可选，缺省 = start + 1 小时
 */
export function validateEventInput(input, path = 'event') {
  const base = validateObject(
    {
      title: nonEmptyString,
      description: optional(string, ''),
      location: optional(string, ''),
      allDay: boolean,
      startDate: optional(isoDateString, undefined),
      endDate: optional(isoDateString, undefined),
      start: optional(wallClock, undefined),
      end: optional(wallClock, undefined),
      timeZone: optional(ianaTimeZone, undefined),
      recurrence: optional(recurrenceValidator, undefined),
      importance: optional(oneOf(IMPORTANCE_LEVELS), 'normal'),
      tags: optional(arrayOf(nonEmptyString, { max: 32 }), []),
      source: optional(oneOf(EVENT_SOURCES), 'local'),
      uid: optional(nonEmptyString, undefined),
    },
    input,
    { path },
  )

  if (base.allDay) {
    if (base.startDate === undefined) {
      throw validationError('全天事件必须给 startDate', { path })
    }
    if (base.start !== undefined || base.end !== undefined) {
      throw validationError('全天事件不能给 start/end 墙钟时间', { path })
    }
    // timeZone 允许：全天事件需要它来表达「哪一天」在哪个时区成立
    if (base.endDate !== undefined && base.endDate <= base.startDate) {
      throw validationError('全天事件 endDate 必须晚于 startDate（含端不含）', {
        path,
        startDate: base.startDate,
        endDate: base.endDate,
      })
    }
    if (base.recurrence !== undefined) {
      // 全天重复允许，但时区无意义；不额外限制
    }
    return base
  }

  if (base.start === undefined) {
    throw validationError('非全天事件必须给 start 墙钟时间', { path })
  }
  if (base.timeZone === undefined) {
    throw validationError('非全天事件必须给 timeZone', { path })
  }
  if (base.startDate !== undefined || base.endDate !== undefined) {
    throw validationError('非全天事件不能用 startDate/endDate，请用 start/end', { path })
  }
  if (base.end !== undefined && base.end <= base.start) {
    throw validationError('end 必须晚于 start', { path, start: base.start, end: base.end })
  }
  return base
}

/**
 * 把已校验的输入归一成存储行（不含 id/时间戳，由 repo 补）。
 * @returns {object}
 */
export function normalizeEventInput(input) {
  const out = {
    title: input.title,
    description: input.description ?? '',
    location: input.location ?? '',
    allDay: input.allDay,
    importance: input.importance ?? 'normal',
    tags: [...(input.tags ?? [])],
    source: input.source ?? 'local',
    status: 'confirmed',
  }
  if (input.allDay) {
    out.startDate = input.startDate
    out.endDate = input.endDate ?? null
    // 全天事件也保留 timeZone：它决定「startDate 是哪一天」在哪个时区成立。
    // 缺省 null 表示按 UTC 锚定（跨时区仍读作同一本地日）。
    out.timeZone = input.timeZone ?? null
    out.start = null
    out.end = null
  } else {
    out.timeZone = input.timeZone
    out.start = input.start
    out.end = input.end ?? null
    out.startDate = null
    out.endDate = null
  }
  out.recurrence = input.recurrence === undefined ? null : input.recurrence
  if (input.uid !== undefined) out.uid = input.uid
  return out
}

/**
 * 计算事件的 UTC 时间区间（毫秒）。全天事件按 `timeZone` 的 00:00 起算，
 * 缺省时区用 UTC（调用方可传 timeZone 覆盖，如 `Asia/Shanghai`）。
 *
 * @returns {{ startMs: number, endMs: number, allDay: boolean }}
 */
export function eventInstantRange(event, fallbackTimeZone = 'UTC') {
  if (event.allDay) {
    // 全天事件也必须有明确时区：优先事件自身 timeZone，其次调用方默认，最后 UTC
    const tz = event.timeZone ?? fallbackTimeZone
    const startMs = wallToInstant(`${event.startDate}T00:00:00`, tz).ms
    const endDate = event.endDate ?? nextDate(event.startDate)
    const endMs = wallToInstant(`${endDate}T00:00:00`, tz).ms
    return { startMs, endMs, allDay: true }
  }
  const tz = event.timeZone ?? fallbackTimeZone
  const startMs = wallToInstant(normalizeWall(event.start), tz).ms
  const endMs = event.end === null || event.end === undefined
    ? startMs + 3600000
    : wallToInstant(normalizeWall(event.end), tz).ms
  return { startMs, endMs, allDay: false }
}

/** `YYYY-MM-DDTHH:mm` → `YYYY-MM-DDTHH:mm:00`，便于统一解析。 */
export function normalizeWall(wall) {
  return wall.length === 16 ? `${wall}:00` : wall
}

function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) + 86400000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

export { isoInstant }

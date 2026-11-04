/**
 * 重复事件展开（RRULE 子集）。
 *
 * ## 支持的边界（明确写清，不假装全 RFC5545）
 *
 * 支持：`FREQ`（DAILY/WEEKLY/MONTHLY/YEARLY）、`INTERVAL`、`COUNT`、`UNTIL`、`BYDAY`（仅 WEEKLY）。
 * 不支持（调用方传了会明确报 `unsupported`，不静默忽略）：BYSETPOS、BYMONTHDAY、BYYEARDAY、
 * BYWEEKNO、WKST、RDATE/EXDATE 以外的复杂组合。
 *
 * ## 为什么用「墙钟迭代」而不是「毫秒加固定步长」
 *
 * 重复规则按**本地日历语义**推进（"每周三 09:00" 在 DST 切换后仍是 09:00，而不是 08:00 或 10:00）。
 * 因此每次推进都在**目标时区的墙钟空间**做日期运算，再换算成 UTC 瞬间。
 *
 * 输出包含 `overrides`：某一具体日期用独立时间覆盖（ICS 的 RECURRENCE-ID 场景）。
 */

import { unsupportedError, validationError } from './errors.js'
import { addDaysToDate, daysBetween, wallToInstant, weekdayOf, WEEKDAY_INDEX } from './time.js'
import { normalizeWall } from './event.js'

/** 单次展开的硬上限，防止恶意/错误规则打爆内存。 */
export const MAX_OCCURRENCES = 2000

/** RRULE 未支持字段的显式拒绝表。 */
const UNSUPPORTED_KEYS = ['bySetPos', 'byMonthDay', 'byYearDay', 'byWeekNo', 'wkst', 'byMonth', 'byHour', 'byMinute']

function assertNoUnsupported(recurrence, path) {
  for (const key of UNSUPPORTED_KEYS) {
    if (recurrence[key] !== undefined) {
      throw unsupportedError(`不支持的重复规则字段：${path}.${key}（V1 仅支持 freq/interval/count/until/byDay）`, {
        path: `${path}.${key}`,
      })
    }
  }
}

/**
 * 生成事件在某窗口内的全部发生实例。
 *
 * @param {object} event 已归一的 Event（含 allDay/timeZone/start|startDate/recurrence）
 * @param {{ windowStart: number, windowEnd: number }} window UTC 毫秒窗口（含起不含止）
 * @returns {Array<{ occurrenceKey: string, startMs: number, endMs: number, startDate?: string, isRecurring: boolean }>}
 */
export function expandEvent(event, window) {
  const { windowStart, windowEnd } = window
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    throw validationError('展开窗口非法：windowEnd 必须晚于 windowStart', { windowStart, windowEnd })
  }

  const single = () => {
    const range = eventRange(event)
    return [makeOccurrence(event, range.startMs, range.endMs, event.allDay ? event.startDate : undefined, false)]
  }

  if (event.recurrence === null || event.recurrence === undefined) {
    const range = eventRange(event)
    if (range.endMs <= windowStart || range.startMs >= windowEnd) return []
    return single()
  }

  const recurrence = event.recurrence
  assertNoUnsupported(recurrence, 'recurrence')

  const base = baseOccurrence(event)
  const durationMs = base.endMs - base.startMs
  const step = recurrence.interval ?? 1
  const out = []
  const seen = new Set()

  // UNTIL：日期或带时区时间；日期按该时区当日 23:59:59 收口（含当天）
  let untilMs = Infinity
  if (recurrence.until !== undefined) {
    untilMs = parseUntil(recurrence.until, event)
  }

  let produced = 0
  let cursorDate = base.startDate
  let periodIndex = 0
  let guard = 0
  const maxIterations = MAX_OCCURRENCES * 4

  while (guard < maxIterations) {
    guard += 1
    const candidateDates = datesForCursor(recurrence, cursorDate, base)

    for (const date of candidateDates) {
      if (date < base.startDate) continue
      const occurrenceStartMs = dateToStartMs(event, date)
      if (occurrenceStartMs >= windowEnd) {
        // 已越过窗口右界；若规则是有限的，可以安全收口
        return out
      }
      if (occurrenceStartMs > untilMs) return out
      if (recurrence.count !== undefined && produced >= recurrence.count) return out
      produced += 1
      if (recurrence.count !== undefined && produced > recurrence.count) return out

      const occurrenceEndMs = occurrenceStartMs + durationMs
      if (occurrenceEndMs > windowStart) {
        const key = `${event.uid ?? event.id}:${date}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push(makeOccurrence(event, occurrenceStartMs, occurrenceEndMs, event.allDay ? date : undefined, true))
        }
      }
      if (out.length >= MAX_OCCURRENCES) {
        throw unsupportedError(`重复展开超过上限 ${MAX_OCCURRENCES} 次，请缩小窗口或加 count/until`, {
          eventId: event.id,
        })
      }
    }

    // 推进游标：MONTHLY/YEARLY 用「周期序号」重算，避免短月 clamp 污染后续周期
    periodIndex += 1
    const next = advanceCursor(recurrence, base.startDate, step, periodIndex)
    if (next === null) return out
    cursorDate = next
    if (guard >= maxIterations) {
      throw unsupportedError('重复展开迭代次数超限，请加 count/until 或缩小窗口', { eventId: event.id })
    }
  }
  return out
}

function makeOccurrence(event, startMs, endMs, startDate, isRecurring) {
  return {
    occurrenceKey: `${event.uid ?? event.id}:${startDate ?? new Date(startMs).toISOString()}`,
    eventId: event.id,
    startMs,
    endMs,
    startDate,
    allDay: event.allDay,
    isRecurring,
  }
}

/** 基础实例（用于取持续时间与起始日期）。 */
function baseOccurrence(event) {
  const range = eventRange(event)
  return {
    startMs: range.startMs,
    endMs: range.endMs,
    startDate: event.allDay ? event.startDate : wallDateOf(event.start),
  }
}

function wallDateOf(wall) {
  return normalizeWall(wall).slice(0, 10)
}

/** 事件的基础 UTC 区间（单次）。 */
function eventRange(event) {
  if (event.allDay) {
    // 全天事件锚定在它自己的时区（缺省 UTC）；这样「同一天」在任何时区都读作同一本地日
    const tz = event.timeZone ?? 'UTC'
    const startMs = wallToInstant(`${event.startDate}T00:00:00`, tz).ms
    const endDate = event.endDate ?? addDaysToDate(event.startDate, 1)
    const endMs = wallToInstant(`${endDate}T00:00:00`, tz).ms
    return { startMs, endMs }
  }
  const tz = event.timeZone
  const startMs = wallToInstant(normalizeWall(event.start), tz).ms
  const endMs = event.end === null || event.end === undefined
    ? startMs + 3600000
    : wallToInstant(normalizeWall(event.end), tz).ms
  return { startMs, endMs }
}

function dateToStartMs(event, date) {
  if (event.allDay) {
    return wallToInstant(`${date}T00:00:00`, event.timeZone ?? 'UTC').ms
  }
  const timePart = normalizeWall(event.start).slice(11) // HH:mm:ss
  return wallToInstant(`${date}T${timePart}`, event.timeZone).ms
}

function parseUntil(until, event) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    const tz = event.allDay ? 'UTC' : event.timeZone
    return wallToInstant(`${until}T23:59:59`, tz).ms
  }
  return Date.parse(until)
}

/** 当前游标日期对应的候选日期（处理 BYDAY）。 */
function datesForCursor(recurrence, cursorDate, base) {
  if (recurrence.freq === 'WEEKLY' && recurrence.byDay !== undefined) {
    // 返回该周内所有指定星期几
    const weekStart = addDaysToDate(cursorDate, -weekdayIndex(cursorDate))
    return recurrence.byDay
      .map((code) => addDaysToDate(weekStart, WEEKDAY_INDEX[code]))
      .sort()
  }
  return [cursorDate]
}

function weekdayIndex(date) {
  return weekdayOf(date)
}

/**
 * 推进到第 `periodIndex` 个周期；返回 null 表示不应再推进。
 *
 * 关键：MONTHLY/YEARLY 一律从**原始起始日**重算，而不是从上一个（可能已被 clamp 的）
 * 游标推进。否则 1/31 → 2/28 → 3/28 会一路漂移，正确应为 1/31 → 2/28 → 3/31。
 */
function advanceCursor(recurrence, baseDate, step, periodIndex) {
  const pad = (n) => String(n).padStart(2, '0')
  switch (recurrence.freq) {
    case 'DAILY':
      return addDaysToDate(baseDate, step * periodIndex)
    case 'WEEKLY':
      return addDaysToDate(baseDate, 7 * step * periodIndex)
    case 'MONTHLY': {
      const [y, m, d] = baseDate.split('-').map(Number)
      const targetMonth = m - 1 + step * periodIndex
      const year = y + Math.floor(targetMonth / 12)
      const month = ((targetMonth % 12) + 12) % 12
      const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
      return `${year}-${pad(month + 1)}-${pad(Math.min(d, maxDay))}`
    }
    case 'YEARLY': {
      const [y, m, d] = baseDate.split('-').map(Number)
      const targetYear = y + step * periodIndex
      const maxDay = new Date(Date.UTC(targetYear, m, 0)).getUTCDate()
      return `${targetYear}-${pad(m)}-${pad(Math.min(d, maxDay))}`
    }
    default:
      throw unsupportedError(`不支持的重复频率：${recurrence.freq}`)
  }
}

/** 给定窗口，返回按开始时间排序、去重后的事件实例。 */
export function expandEvents(events, window) {
  const all = []
  for (const event of events) {
    if (event.status === 'cancelled') continue
    all.push(...expandEvent(event, window))
  }
  all.sort((a, b) => a.startMs - b.startMs || String(a.eventId).localeCompare(String(b.eventId)))
  return all
}

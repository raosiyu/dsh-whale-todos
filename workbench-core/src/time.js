/**
 * 时间与时区工具（零依赖，基于 Intl）。
 *
 * 核心难点：**本地墙钟时间 ↔ UTC 瞬间** 的双向换算，且要正确处理 DST。
 *
 * 策略（与时区库对齐的通行做法）：
 * 1. 给「某时区的某个墙钟时刻」，先按 UTC 猜一个瞬间，用该瞬间在目标时区的偏移修正，
 *    迭代两次收敛（偏移变化只可能发生在 DST 边界，两次足够）。
 * 2. 落进 **DST 空档**（spring-forward 不存在的墙钟时刻）时，前移到空档结束时刻。
 * 3. 落进 **DST 重叠**（fall-back 出现两次）时，取**较早**的那个瞬间（文档化选择，避免歧义）。
 *
 * 所有对外接口只传/回 `{ wall: 'YYYY-MM-DDTHH:mm:ss', timeZone }` 或 UTC ISO 字符串，
 * 不传 Date 对象，避免调用方各自解释本地时区。
 */

import { validationError } from './errors.js'

/** 墙钟格式：YYYY-MM-DDTHH:mm 或 YYYY-MM-DDTHH:mm:ss */
export const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

const partsCache = new Map()

/** 取某瞬间在某时区的字段（用 Intl，避免依赖系统时区）。 */
export function zonedParts(instantMs, timeZone) {
  const key = timeZone
  let fmt = partsCache.get(key)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(key, fmt)
  }
  const parts = fmt.formatToParts(new Date(instantMs))
  const pick = (type) => {
    const found = parts.find((p) => p.type === type)
    return found === undefined ? '0' : found.value
  }
  // en-US + hour12:false 在午夜可能给 "24"，归一到 0
  const hour = Number(pick('hour')) % 24
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour,
    minute: Number(pick('minute')),
    second: Number(pick('second')),
  }
}

/** 某瞬间在某时区的 UTC 偏移（毫秒，东正西负）。 */
export function offsetMsAt(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const floored = Math.floor(instantMs / 1000) * 1000
  return asUtc - floored
}

/** 把墙钟字符串解析成「按 UTC 解释」的毫秒数（仅作中间量）。 */
export function wallToUtcGuess(wall) {
  const m = WALL_PATTERN.exec(wall)
  if (m === null) {
    throw validationError(`墙钟时间格式非法：${wall}（应为 YYYY-MM-DDTHH:mm[:ss]）`, { wall })
  }
  const [, y, mo, d, h, mi, s] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0'))
}

/**
 * 墙钟 + 时区 → UTC 瞬间（毫秒）。
 * @returns {{ ms: number, adjusted: 'none'|'gap'|'overlap' }}
 */
export function wallToInstant(wall, timeZone) {
  const guess = wallToUtcGuess(wall)
  // 两轮收敛：offset 依赖瞬间，瞬间依赖 offset
  let ms = guess - offsetMsAt(guess, timeZone)
  ms = guess - offsetMsAt(ms, timeZone)
  const check = guess - offsetMsAt(ms, timeZone)
  if (check !== ms) ms = check

  // 校验往返：该瞬间在目标时区读出来是否等于原墙钟
  const back = zonedParts(ms, timeZone)
  const want = WALL_PATTERN.exec(wall)
  const wantTuple = [
    Number(want[1]), Number(want[2]), Number(want[3]),
    Number(want[4]), Number(want[5]), Number(want[6] ?? '0'),
  ]
  const gotTuple = [back.year, back.month, back.day, back.hour, back.minute, back.second]
  const equal = wantTuple.every((v, i) => v === gotTuple[i])
  if (equal) {
    // 即便往返相等，也可能处于**回拨重叠区**（同一墙钟对应两个瞬间）：
    // 检查 ±1 小时偏移下是否还能解释出同一墙钟，若是则说明有两次，取较早者。
    const oneHour = 3600000
    const altA = ms - oneHour
    const altB = ms + oneHour
    const altAOk = matchesWall(altA, wall, timeZone)
    const altBOk = matchesWall(altB, wall, timeZone)
    if (altAOk || altBOk) {
      const candidates = [ms]
      if (altAOk) candidates.push(altA)
      if (altBOk) candidates.push(altB)
      return { ms: Math.min(...candidates), adjusted: 'overlap' }
    }
    return { ms, adjusted: 'none' }
  }

  // 不相等：要么落在空档（该墙钟不存在），要么落在重叠（该墙钟出现两次）
  const earlier = guess - offsetMsAt(guess - 86400000, timeZone)
  const later = guess - offsetMsAt(guess + 86400000, timeZone)
  const earlierOk = matchesWall(earlier, wall, timeZone)
  const laterOk = matchesWall(later, wall, timeZone)

  if (earlierOk && laterOk) {
    // 重叠：取较早瞬间（文档化选择）
    return { ms: Math.min(earlier, later), adjusted: 'overlap' }
  }
  if (laterOk) return { ms: later, adjusted: 'gap' }
  if (earlierOk) return { ms: earlier, adjusted: 'gap' }
  // 都不可解释（极端时区规则）：前移 1 小时后重试，最多 3 次
  for (let i = 1; i <= 3; i += 1) {
    const shifted = wallToUtcGuess(wall) + i * 3600000
    const candidate = shifted - offsetMsAt(shifted, timeZone)
    if (matchesWall(candidate, wall, timeZone)) return { ms: candidate, adjusted: 'gap' }
  }
  return { ms, adjusted: 'gap' }
}

function matchesWall(instantMs, wall, timeZone) {
  const p = zonedParts(instantMs, timeZone)
  const m = WALL_PATTERN.exec(wall)
  return (
    p.year === Number(m[1]) && p.month === Number(m[2]) && p.day === Number(m[3]) &&
    p.hour === Number(m[4]) && p.minute === Number(m[5]) && p.second === Number(m[6] ?? '0')
  )
}

/** UTC 瞬间 → 某时区的墙钟字符串。 */
export function instantToWall(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/** 把 `YYYY-MM-DD` 加天数（纯日期运算，与时区无关）。 */
export function addDaysToDate(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + days * 86400000
  const dt = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** 纯日期字符串 → 该日期在 UTC 午夜的毫秒（仅用于日期差/星期计算）。 */
export function dateToUtcMs(date) {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** 两个纯日期的天数差（b - a）。 */
export function daysBetween(a, b) {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / 86400000)
}

/** 星期（0=周日 … 6=周六）。 */
export function weekdayOf(date) {
  return new Date(dateToUtcMs(date)).getUTCDay()
}

/**
 * RRULE BYDAY 代号 → JS 星期索引（0=周日 … 6=周六）。
 * 放在 time.js 是因为「星期」属于时间语义，recurrence.js 只消费它。
 */
export const WEEKDAY_INDEX = Object.freeze({
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
})

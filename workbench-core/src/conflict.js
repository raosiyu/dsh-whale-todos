/**
 * 冲突检测与空闲时段计算。
 *
 * ## 判定规则（明确、可测）
 *
 * - 区间半开 `[start, end)`：首尾相接不算冲突（09:00–10:00 与 10:00–11:00 相邻，无冲突）。
 * - 全天事件与全天事件**永不互相冲突**（同一天多个全天事项是常态，比如"生日 + 假期"）。
 * - 全天事件与定时事件：默认**不冲突**（全天事项是背景，不占具体时段）；
 *   需要"全天占用"时由调用方显式传 `allDayBlocks = true`。
 * - 已取消（`cancelled`）的实例不参与冲突。
 *
 * 这些选择都写进测试，避免"看起来实现了"但语义飘。
 */

import { validationError } from './errors.js'
import { expandEvents } from './recurrence.js'

/**
 * 找出互相重叠的实例对。
 *
 * @param {Array<object>} instances `expandEvents` 的输出
 * @param {{ allDayBlocks?: boolean }} [options]
 * @returns {Array<{ a: object, b: object, overlapMs: number }>}
 */
export function findConflicts(instances, options = {}) {
  const allDayBlocks = options.allDayBlocks === true
  const sorted = [...instances].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs)
  const conflicts = []
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]
      const b = sorted[j]
      if (b.startMs >= a.endMs) break // 已排序：后面的都更晚，不可能与 a 重叠
      if (a.eventId === b.eventId && a.occurrenceKey === b.occurrenceKey) continue
      if (a.allDay && b.allDay) continue
      if (a.allDay !== b.allDay && !allDayBlocks) continue
      const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
      if (overlapMs > 0) conflicts.push({ a, b, overlapMs })
    }
  }
  return conflicts
}

/**
 * 在给定窗口内找空闲时段。
 *
 * @param {Array<object>} events 已归一的 Event 列表
 * @param {{
 *   windowStart: number, windowEnd: number,
 *   minSlotMs?: number, bufferMs?: number,
 *   workday?: { startHour: number, endHour: number, timeZone: string },
 *   allDayBlocks?: boolean,
 * }} input
 * @returns {{ free: Array<{ startMs: number, endMs: number }>, busy: Array<{ startMs: number, endMs: number }> }}
 */
export function findFreeSlots(events, input) {
  const { windowStart, windowEnd } = input
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    throw validationError('空闲计算窗口非法', { windowStart, windowEnd })
  }
  const minSlotMs = input.minSlotMs ?? 30 * 60000
  const bufferMs = input.bufferMs ?? 0
  const allDayBlocks = input.allDayBlocks === true

  const instances = expandEvents(events, { windowStart, windowEnd })
  const busy = instances
    .filter((inst) => (inst.allDay ? allDayBlocks : true))
    .map((inst) => ({ startMs: inst.startMs, endMs: inst.endMs }))
    .sort((a, b) => a.startMs - b.startMs)

  // 合并重叠/相邻（含 buffer）
  const merged = []
  for (const slot of busy) {
    const start = slot.startMs - bufferMs
    const end = slot.endMs + bufferMs
    const last = merged[merged.length - 1]
    if (last !== undefined && start <= last.endMs) {
      last.endMs = Math.max(last.endMs, end)
    } else {
      merged.push({ startMs: start, endMs: end })
    }
  }

  const free = []
  let cursor = windowStart
  for (const block of merged) {
    if (block.startMs > cursor) {
      const gap = { startMs: cursor, endMs: Math.min(block.startMs, windowEnd) }
      if (gap.endMs - gap.startMs >= minSlotMs) free.push(gap)
    }
    cursor = Math.max(cursor, block.endMs)
    if (cursor >= windowEnd) break
  }
  if (cursor < windowEnd && windowEnd - cursor >= minSlotMs) {
    free.push({ startMs: cursor, endMs: windowEnd })
  }
  return { free, busy: merged }
}

/**
 * 校验"新建/修改某事件是否会与已有事件冲突"，供服务层在写入前调用。
 *
 * @returns {{ conflicts: Array<object>, blocking: boolean }}
 */
export function checkEventConflicts(events, candidate, options = {}) {
  const { windowStart, windowEnd } = options
  const win = windowStart !== undefined && windowEnd !== undefined
    ? { windowStart, windowEnd }
    : defaultWindowFor(candidate)
  const all = [...events.filter((e) => e.id !== candidate.id), candidate]
  const instances = expandEvents(all, win)
  const candidateInstances = instances.filter((inst) => inst.eventId === candidate.id)
  const conflicts = findConflicts(instances, { allDayBlocks: options.allDayBlocks === true })
    .filter((c) => c.a.eventId === candidate.id || c.b.eventId === candidate.id)
  return {
    conflicts,
    candidateInstances,
    blocking: conflicts.length > 0 && options.allowOverlap !== true,
  }
}

/** 没有显式窗口时，围绕候选事件取 ±400 天的窗口（覆盖常见重复规则）。 */
function defaultWindowFor(candidate) {
  const dayMs = 86400000
  const anchor = candidate.allDay
    ? Date.parse(`${candidate.startDate}T00:00:00Z`)
    : Date.parse(`${candidate.start.length === 16 ? `${candidate.start}:00` : candidate.start}Z`)
  const base = Number.isFinite(anchor) ? anchor : Date.now()
  return { windowStart: base - 400 * dayMs, windowEnd: base + 400 * dayMs }
}

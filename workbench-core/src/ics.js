/**
 * ICS（iCalendar）导入导出 —— VEVENT 子集。
 *
 * ## 支持范围（明确边界）
 *
 * 导入：`VCALENDAR` 内的 `VEVENT`；字段 `UID / SUMMARY / DESCRIPTION / LOCATION / DTSTART /
 * DTEND / RRULE / STATUS / X-WORKBENCH-IMPORTANCE / X-WORKBENCH-TAGS`；`VALUE=DATE` 识别为全天。
 * 导出：生成同样子集，行折叠按 RFC5545（75 octet）保守处理。
 *
 * 不支持：VTODO / VJOURNAL / VFREEBUSY / VTIMEZONE 的完整规则展开（`TZID` 仅保留为事件时区名）、
 * RECURRENCE-ID 例外（导入时忽略该实例并记 warning）、ATTENDEE/VALARM 保留不解析。
 *
 * ## 导入必须"先预览再写入"
 *
 * `parseIcs` 只解析不写库；`previewImport` 给出将新增/跳过/冲突的数量与明细；
 * 真正落库由服务层在用户确认后调用 `applyImport`（内部先备份，失败自动回滚）。
 */

import { unsupportedError, validationError } from './errors.js'
import { addDaysToDate } from './time.js'

const CRLF = '\r\n'

/** 解折行：RFC5545 的续行以空格/制表符开头。 */
function unfold(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const out = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

/** 按第一个未转义的冒号拆 key/params/value。 */
function splitProperty(line) {
  let inQuote = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === ':' && !inQuote) {
      return { head: line.slice(0, i), value: line.slice(i + 1) }
    }
  }
  return { head: line, value: '' }
}

/** 解析 `DTSTART;TZID=Asia/Shanghai;VALUE=DATE-TIME:20261105T090000` 形式。 */
function parseHead(head) {
  const [name, ...paramParts] = head.split(';')
  const params = {}
  for (const part of paramParts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }
  return { name: name.toUpperCase(), params }
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** `20261105T090000` / `20261105` / `20261105T090000Z` → 结构。 */
function parseDateTime(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw)
  if (m === null) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined) {
    return { allDay: true, date: `${y}-${mo}-${d}` }
  }
  return {
    allDay: false,
    wall: `${y}-${mo}-${d}T${h}:${mi}:${s}`,
    utc: z === 'Z',
  }
}

/** 解析 RRULE 值：`FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE`。 */
function parseRRule(value) {
  const parts = Object.fromEntries(
    value.split(';').filter(Boolean).map((kv) => {
      const eq = kv.indexOf('=')
      return [kv.slice(0, eq).toUpperCase(), kv.slice(eq + 1)]
    }),
  )
  const out = { freq: parts.FREQ }
  if (parts.INTERVAL !== undefined) out.interval = Number(parts.INTERVAL)
  if (parts.COUNT !== undefined) out.count = Number(parts.COUNT)
  if (parts.UNTIL !== undefined) {
    const parsed = parseDateTime(parts.UNTIL)
    out.until = parsed === null ? parts.UNTIL : parsed.allDay ? parsed.date : parsed.wall
  }
  if (parts.BYDAY !== undefined) out.byDay = parts.BYDAY.split(',').map((x) => x.toUpperCase())
  return out
}

/**
 * 解析 ICS 文本。
 * @param {string} text
 * @param {{ defaultTimeZone?: string }} [options]
 * @returns {{ events: object[], warnings: string[], errors: string[] }}
 */
export function parseIcs(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw validationError('ICS 内容为空')
  }
  const defaultTimeZone = options.defaultTimeZone ?? 'UTC'
  const lines = unfold(text)
  const events = []
  const warnings = []
  const errors = []

  let inEvent = false
  let current = null
  let sawCalendar = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line === 'BEGIN:VCALENDAR') { sawCalendar = true; continue }
    if (line === 'END:VCALENDAR') continue
    if (line === 'BEGIN:VEVENT') { inEvent = true; current = { props: {} }; continue }
    if (line === 'END:VEVENT') {
      if (current !== null) {
        const built = buildEvent(current, { defaultTimeZone, warnings, errors })
        if (built !== null) events.push(built)
      }
      inEvent = false
      current = null
      continue
    }
    if (!inEvent || current === null) continue
    if (line.startsWith('BEGIN:VTODO') || line.startsWith('BEGIN:VJOURNAL') || line.startsWith('BEGIN:VFREEBUSY')) {
      warnings.push(`跳过不支持的组件：${line.slice(6)}`)
      continue
    }
    const { head, value } = splitProperty(line)
    const { name, params } = parseHead(head)
    current.props[name] = { value, params }
  }

  if (!sawCalendar) throw validationError('不是合法的 ICS：缺少 BEGIN:VCALENDAR')
  if (events.length === 0 && errors.length === 0) {
    warnings.push('文件里没有可导入的 VEVENT')
  }
  return { events, warnings, errors }
}

function buildEvent(holder, { defaultTimeZone, warnings, errors }) {
  const p = holder.props
  const summary = p.SUMMARY === undefined ? '' : unescapeText(p.SUMMARY.value).trim()
  if (p['RECURRENCE-ID'] !== undefined) {
    warnings.push(`忽略 RECURRENCE-ID 例外实例：${summary || p.UID?.value || '(无标题)'}`)
    return null
  }
  const dtstart = p.DTSTART === undefined ? null : parseDateTime(p.DTSTART.value)
  if (dtstart === null) {
    errors.push(`VEVENT 缺少可解析的 DTSTART：${summary || '(无标题)'}`)
    return null
  }
  const dtend = p.DTEND === undefined ? null : parseDateTime(p.DTEND.value)

  const base = {
    title: summary === '' ? '(无标题)' : summary,
    description: p.DESCRIPTION === undefined ? '' : unescapeText(p.DESCRIPTION.value),
    location: p.LOCATION === undefined ? '' : unescapeText(p.LOCATION.value),
    source: 'ics',
  }
  if (p.UID !== undefined) base.uid = p.UID.value

  if (dtstart.allDay) {
    base.allDay = true
    base.startDate = dtstart.date
    if (dtend !== null && dtend.allDay) base.endDate = dtend.date
  } else {
    base.allDay = false
    const tzid = p.DTSTART.params.TZID
    if (dtstart.utc) {
      // 带 Z：转成目标时区墙钟
      const instant = Date.parse(`${dtstart.wall.replace(' ', 'T')}Z`)
      base.timeZone = tzid ?? defaultTimeZone
      base.start = toWallInZone(instant, base.timeZone)
    } else {
      base.timeZone = tzid ?? defaultTimeZone
      base.start = dtstart.wall
    }
    if (dtend !== null && !dtend.allDay) {
      if (dtend.utc) {
        const instant = Date.parse(`${dtend.wall.replace(' ', 'T')}Z`)
        base.end = toWallInZone(instant, base.timeZone)
      } else {
        base.end = dtend.wall
      }
    }
  }

  if (p.RRULE !== undefined) {
    try {
      base.recurrence = parseRRule(p.RRULE.value)
    } catch (error) {
      warnings.push(`RRULE 解析失败已忽略：${String(error?.message ?? error)}`)
    }
  }
  if (p.STATUS !== undefined && p.STATUS.value.toUpperCase() === 'CANCELLED') {
    base.status = 'cancelled'
  }
  if (p['X-WORKBENCH-IMPORTANCE'] !== undefined) {
    const v = p['X-WORKBENCH-IMPORTANCE'].value.toLowerCase()
    if (['low', 'normal', 'high'].includes(v)) base.importance = v
  }
  if (p['X-WORKBENCH-TAGS'] !== undefined) {
    base.tags = p['X-WORKBENCH-TAGS'].value.split(',').map((x) => x.trim()).filter(Boolean)
  }
  return base
}

function toWallInZone(instantMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]))
  const hour = String(Number(parts.hour) % 24).padStart(2, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`
}

/** 折行：每行不超过 75 octet（保守按字符计，中文场景足够）。 */
function foldLine(line) {
  if (line.length <= 73) return line
  const chunks = []
  let rest = line
  chunks.push(rest.slice(0, 73))
  rest = rest.slice(73)
  while (rest.length > 0) {
    chunks.push(` ${rest.slice(0, 72)}`)
    rest = rest.slice(72)
  }
  return chunks.join(CRLF)
}

const fmtDateTime = (wall) => {
  // 归一为 HH:mm:ss 再压成 HHMMSS，避免 09:00 → 0900（缺秒导致回读失败）
  const [datePart, timePart = '00:00:00'] = wall.split('T')
  const [hh = '00', mm = '00', ss = '00'] = timePart.split(':')
  return `${datePart.replace(/-/g, '')}T${hh.padStart(2, '0')}${mm.padStart(2, '0')}${ss.padStart(2, '0')}`
}
const fmtDate = (date) => date.replace(/-/g, '')

/** 生成 RRULE 值。 */
function formatRRule(recurrence) {
  const parts = [`FREQ=${recurrence.freq}`]
  if (recurrence.interval !== undefined && recurrence.interval !== 1) parts.push(`INTERVAL=${recurrence.interval}`)
  if (recurrence.count !== undefined) parts.push(`COUNT=${recurrence.count}`)
  if (recurrence.until !== undefined) {
    parts.push(`UNTIL=${recurrence.until.includes('T') ? fmtDateTime(recurrence.until) : fmtDate(recurrence.until)}`)
  }
  if (recurrence.byDay !== undefined) parts.push(`BYDAY=${recurrence.byDay.join(',')}`)
  return parts.join(';')
}

/**
 * 导出事件为 ICS 文本。
 * @param {Array<object>} events 已归一的事件
 * @param {{ calendarName?: string, prodId?: string }} [options]
 */
export function buildIcs(events, options = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${options.prodId ?? '-//dsh-workbench//workbench-core//EN'}`,
    'CALSCALE:GREGORIAN',
  ]
  if (options.calendarName !== undefined) {
    lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`)
  }
  for (const event of events) {
    if (event.status === 'cancelled') continue
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${event.uid ?? event.id}`)
    lines.push(`DTSTAMP:${fmtDateTime(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', 'T'))}`)
    lines.push(`SUMMARY:${escapeText(event.title)}`)
    if (event.description !== '') lines.push(`DESCRIPTION:${escapeText(event.description)}`)
    if (event.location !== '') lines.push(`LOCATION:${escapeText(event.location)}`)

    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(event.startDate)}`)
      if (event.endDate !== null && event.endDate !== undefined) {
        lines.push(`DTEND;VALUE=DATE:${fmtDate(event.endDate)}`)
      }
    } else {
      lines.push(`DTSTART;TZID=${event.timeZone}:${fmtDateTime(event.start)}`)
      if (event.end !== null && event.end !== undefined) {
        lines.push(`DTEND;TZID=${event.timeZone}:${fmtDateTime(event.end)}`)
      }
    }
    if (event.recurrence !== null && event.recurrence !== undefined) {
      lines.push(`RRULE:${formatRRule(event.recurrence)}`)
    }
    if (event.importance !== 'normal') {
      lines.push(`X-WORKBENCH-IMPORTANCE:${event.importance}`)
    }
    if (Array.isArray(event.tags) && event.tags.length > 0) {
      lines.push(`X-WORKBENCH-TAGS:${event.tags.map(escapeText).join(',')}`)
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`
}

/** 全量导出为 JSON 快照（含版本与指纹，便于导入校验）。 */
export function exportJson(snapshot, meta = {}) {
  return JSON.stringify(
    {
      format: 'dsh-workbench-snapshot',
      version: 1,
      exportedAt: meta.exportedAt ?? new Date().toISOString(),
      fingerprint: meta.fingerprint ?? null,
      events: snapshot.events ?? [],
      tasks: snapshot.tasks ?? [],
    },
    null,
    2,
  )
}

/**
 * 解析 JSON 快照，只做结构检查，不写库。
 * @returns {{ events: object[], tasks: object[], warnings: string[] }}
 */
export function parseJsonSnapshot(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw validationError('JSON 不是合法格式', { reason: String(error?.message ?? error) })
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw validationError('JSON 快照根节点必须是对象')
  }
  if (data.format !== undefined && data.format !== 'dsh-workbench-snapshot') {
    throw unsupportedError(`不支持的快照格式：${data.format}`, { format: data.format })
  }
  if (data.version !== undefined && data.version > 1) {
    throw unsupportedError(`快照版本 ${data.version} 高于本程序支持的 1`, { version: data.version })
  }
  const events = data.events ?? []
  if (!Array.isArray(events)) throw validationError('events 必须是数组')
  const tasks = data.tasks ?? []
  if (!Array.isArray(tasks)) throw validationError('tasks 必须是数组')
  return { events, tasks, warnings: [] }
}

export { addDaysToDate }

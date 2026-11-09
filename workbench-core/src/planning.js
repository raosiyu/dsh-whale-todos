/**
 * WP6-B · 确定性智能规划引擎（纯函数，零 DSH 依赖）。
 *
 * ## 定位（重要，别误读）
 *
 * DSH **不内置 NLP**：自然语言 → 工具参数的映射由模型读 tool schema 完成
 * （见 docs/wp3/03）。所以本模块**不做文本解析**，它做的是第二步：
 *
 *   模型已把用户意图翻译成结构化输入（goal / 任务列表 / 时间窗 / 每日容量）
 *   → 本引擎基于**真实** tasks / events / freeSlots / conflicts
 *   → 产出结构化提案 items（拆解、排期、优先级、冲突、原因）
 *   → 交给 proposal.preview 存为 pending
 *   → 用户确认后 proposal.apply 才落库
 *
 * 这样「AI 智能规划」是真实可用的：AI 负责语义，引擎负责确定性的
 * 优先级/耗时/空闲时段计算，且复用既有唯一真相源（不自己造一份冲突检测）。
 *
 * ## 三条硬纪律
 *
 * 1. 只用调用方传入的真实数据（tasks/events/freeSlots/conflicts），不读文件；
 * 2. 所有输出都是**提案**，绝不写任何数据；
 * 3. 原因说明是给「用户」看的，不是给模型执行的指令；文本一律经净化。
 */

import {
  PROPOSAL_ALLOWED_OPS,
  MAX_ITEMS,
  MIN_ESTIMATE_MINUTES,
  MAX_ESTIMATE_MINUTES,
  sanitizeUntrustedText,
} from './proposal.js'

/** 默认每日可用分钟（可被 capacityMinutesPerDay 覆盖，1..1440）。 */
export const DEFAULT_DAILY_CAPACITY = 480

/** 优先级排序权重（数字小的先排）。 */
export const PRIORITY_WEIGHT = Object.freeze({ high: 0, normal: 1, low: 2 })

/** 排期建议一次最多几条（防提案膨胀）。 */
export const MAX_SCHEDULE_ITEMS = 20

/**
 * 生成规划提案的**结构化输入**（供 proposal.preview 消费）。
 *
 * @param {{
 *   goal?: unknown,                       // 用户自然语言（不可信，仅记录）
 *   taskIds?: unknown[],                  // 要规划的既有任务 id（可选）
 *   targetTitles?: unknown[],             // 要新建/拆解的目标标题（可选，模型拆解结果）
 *   windowStart?: number,                 // 时间窗起（ms）
 *   windowEnd?: number,                   // 时间窗止（ms）
 *   capacityMinutesPerDay?: number,       // 每日容量
 *   tasks?: object[],                     // 真实 task.list 结果
 *   freeSlots?: object[],                 // 真实 event.freeSlots 结果
 *   conflicts?: object[],                 // 真实 event.conflicts 结果
 *   now?: () => Date,
 * }} input
 * @returns {{
 *   items: object[], conflicts: object[], reasoning: string,
 *   stats: {decomposed:number, scheduled:number, overloaded:boolean, usedMinutes:number, capacityMinutes:number}
 * }}
 */
export function buildPlanSuggestion(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('规划输入必须是对象')
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const freeSlots = Array.isArray(input.freeSlots) ? input.freeSlots : []
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : []
  const goal = sanitizeUntrustedText(input.goal, 1000)
  const capacity = normalizeCapacity(input.capacityMinutesPerDay)
  const now = (input.now ?? (() => new Date()))()

  // ---- 1) 选定要规划的任务（既有 id 优先，其次目标标题）
  const selected = selectTasks(tasks, input.taskIds)
  const newTitles = normalizeTitles(input.targetTitles)

  // ---- 2) 拆解：把复杂目标拆成子任务 items（模型已给标题，引擎做结构化）
  const items = []
  const reasons = []

  // 2a) 新建任务（来自模型拆解的标题）
  for (const title of newTitles) {
    if (items.length >= MAX_ITEMS) break
    items.push({
      op: 'task.create',
      payload: {
        title,
        priority: inferPriority(title),
        // dueAt 由排期阶段补；此处不猜具体日期
      },
      reason: `从目标「${goal || '用户目标'}」拆解出的可执行子任务`,
    })
  }
  reasons.push(`按目标拆解出 ${newTitles.length} 条可执行子任务`)

  // ---- 3) 排期：按优先级 + 截止时间 + 预计耗时，往真实空闲时段里放
  const candidates = [...selected, ...newTitles.map((title, i) => ({
    id: `__new_${i}`,
    title,
    priority: inferPriority(title),
    estimatedMinutes: undefined,
    dueAt: undefined,
  }))]

  const ranked = rankTasks(candidates, now)
  const schedule = scheduleIntoSlots(ranked, freeSlots, capacity, now)
  for (const entry of schedule.placed) {
    if (items.length >= MAX_ITEMS + MAX_SCHEDULE_ITEMS) break
    // 建议日程：用真实空闲时段生成一个 event.create 提案
    items.push({
      op: 'event.create',
      payload: {
        title: `专注：${entry.title}`,
        allDay: false,
        start: entry.start,
        end: entry.end,
        timeZone: 'Asia/Shanghai',
      },
      reason: `优先级 ${entry.priority}、预计 ${entry.minutes} 分钟，安排在时间窗内空闲时段`,
    })
  }

  // 3b) 把排期结果回填到对应「新建任务」的 dueAt。
  //
  // 为什么必须回填：新建任务的原注释写着「dueAt 由排期阶段补」，但排期阶段
  // 此前只产出了 event.create，没有回写任务。用户在界面确认写入后拿到一条
  // **没有任何日期**的待办——它同时进不了「今日」，只能落进「计划中」，
  // 于是刚拆出来的任务看起来像"消失"了。日程与任务是同一次拆解的两个侧面，
  // 既然已经算出它几点做，就应该把那个时间写回任务本身。
  //
  // 只回填本次新建的任务（`__new_i`），既有任务的时间由用户自己掌控，不覆盖。
  //
  // 注意：entry.end 是 wallClock 产出的**去时区本地墙钟**串，event.create 接受它，
  // 但 task.dueAt 有硬校验「必须带 Z 或 ±HH:MM」。因此这里补上本机偏移，
  // 语义等价（同一瞬间），不改变用户看到的时间。
  for (const entry of schedule.placed) {
    if (typeof entry.id !== 'string' || !entry.id.startsWith('__new_')) continue
    const idx = Number(entry.id.slice('__new_'.length))
    if (!Number.isInteger(idx) || idx < 0 || idx >= newTitles.length) continue
    const title = newTitles[idx]
    const target = items.find((it) => it.op === 'task.create' && it.payload.title === title)
    if (target === undefined) continue
    const dueAt = withLocalOffset(entry.end)
    if (dueAt !== undefined) target.payload.dueAt = dueAt
  }
  reasons.push(`按优先级与预计耗时，在真实空闲时段排出 ${schedule.placed.length} 个专注时段`)

  // ---- 4) 冲突/过载检测（复用传入的真实冲突与容量账本，不自己造）
  const overloaded = schedule.usedMinutes > capacity
  if (overloaded) {
    reasons.push(`安排过满：需要 ${schedule.usedMinutes} 分钟，超出每日容量 ${capacity} 分钟；建议缩减或延期低优先级任务`)
  }
  if (conflicts.length > 0) {
    reasons.push(`检测到 ${conflicts.length} 处既有日程冲突，提案未覆盖这些时段`)
  }
  for (const task of ranked) {
    if (typeof task.dueAt === 'string' && task.dueAt !== '') {
      const due = Date.parse(task.dueAt)
      if (Number.isFinite(due) && due < now.getTime()) {
        reasons.push(`任务「${task.title}」已过期（截止时间 ${task.dueAt}），建议改期或拆分`)
      }
    }
  }

  // ---- 5) 没有可落地 item 时给一条「仅提示」提案，避免空提案
  if (items.length === 0) {
    items.push({
      op: 'task.create',
      payload: { title: goal ? `跟进：${goal.slice(0, 60)}` : '跟进待规划目标', priority: 'normal' },
      reason: '未发现既有任务或空闲时段，先建一条待跟进任务',
    })
  }

  return {
    items: items.slice(0, MAX_ITEMS),
    conflicts: conflicts.slice(0, MAX_ITEMS),
    reasoning: reasons.join('；'),
    stats: {
      decomposed: newTitles.length,
      scheduled: schedule.placed.length,
      overloaded,
      usedMinutes: schedule.usedMinutes,
      capacityMinutes: capacity,
    },
  }
}

/** 每日容量校验：非法回落到默认，不整份拒绝（这是用户可调参数）。 */
function normalizeCapacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return DEFAULT_DAILY_CAPACITY
  }
  if (value < MIN_ESTIMATE_MINUTES || value > MAX_ESTIMATE_MINUTES) return DEFAULT_DAILY_CAPACITY
  return value
}

/** 只保留真实存在的任务（防 AI 伪造 id 指向别的会话数据）。 */
function selectTasks(tasks, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const allowed = new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
  return tasks.filter((t) => allowed.has(t.id) && !isDeleted(t) && t.done !== true)
}

function isDeleted(t) {
  return t?.deleted === true || (typeof t?.deletedAt === 'string' && t.deletedAt !== '')
}

/** 标题净化 + 去重 + 截断。 */
export function normalizeTitles(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (out.length >= MAX_ITEMS) break
    const title = sanitizeUntrustedText(typeof item === 'string' ? item : item?.title, 200).trim()
    if (title === '' || seen.has(title)) continue
    seen.add(title)
    out.push(title)
  }
  return out
}

/** 优先级推断：标题里的紧急词只作为展示提示，不当作权威指令。 */
export function inferPriority(title) {
  const t = String(title ?? '')
  if (/紧急|asap|urgent|今天|today|立即/i.test(t)) return 'high'
  if (/有空|以后|someday|低优/i.test(t)) return 'low'
  return 'normal'
}

/**
 * 排序：优先级 → 截止时间（早的先）→ 预计耗时（短的先）。
 * 稳定排序，保证同样输入同样输出（可复跑）。
 */
export function rankTasks(tasks, now) {
  const nowMs = now.getTime()
  return [...tasks]
    .map((t, index) => ({
      id: t.id ?? `__anon_${index}`,
      title: String(t.title ?? ''),
      priority: PRIORITY_WEIGHT[t.priority] !== undefined ? t.priority : 'normal',
      dueAt: typeof t.dueAt === 'string' ? t.dueAt : undefined,
      estimatedMinutes: normalizeEstimate(t.estimatedMinutes),
      _index: index,
    }))
    .sort((a, b) => {
      const p = (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1)
      if (p !== 0) return p
      const da = a.dueAt === undefined ? Infinity : Date.parse(a.dueAt)
      const db = b.dueAt === undefined ? Infinity : Date.parse(b.dueAt)
      const fa = Number.isFinite(da) && da >= nowMs ? da : Infinity
      const fb = Number.isFinite(db) && db >= nowMs ? db : Infinity
      if (fa !== fb) return fa - fb
      if (a.estimatedMinutes !== b.estimatedMinutes) return a.estimatedMinutes - b.estimatedMinutes
      return a._index - b._index
    })
    .map(({ _index, ...rest }) => rest)
}

function normalizeEstimate(value) {
  if (typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_ESTIMATE_MINUTES && value <= MAX_ESTIMATE_MINUTES) return value
  return 30 // 未提供时的兜底（Dely0 DEFAULT_PLAN_MINUTES 口径）
}

/**
 * 把任务放进**真实空闲时段**。
 *
 * freeSlots 形状来自 `event.freeSlots`（findFreeSlots）：每个元素含
 * start/end（毫秒或 ISO）。这里兼容两种，且只使用调用方传入的数据。
 */
export function scheduleIntoSlots(ranked, freeSlots, capacity, now) {
  const placed = []
  let usedMinutes = 0
  const nowMs = now.getTime()

  for (const slot of freeSlots) {
    // findFreeSlots 的真实字段是 startMs/endMs（毫秒）；也兼容 start/end
    let cursor = toMs(slot?.startMs ?? slot?.start ?? slot?.startMs)
    const end = toMs(slot?.endMs ?? slot?.end ?? slot?.endMs)
    if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) continue
    if (cursor < nowMs) cursor = nowMs
    for (const task of ranked) {
      if (placed.length >= MAX_SCHEDULE_ITEMS) break
      if (placed.some((p) => p.id === task.id)) continue
      const minutes = task.estimatedMinutes
      if (usedMinutes + minutes > capacity) continue // 容量满了，不再排
      const slotEnd = cursor + minutes * 60_000
      if (slotEnd > end) continue
      placed.push({
        id: task.id,
        title: task.title,
        priority: task.priority,
        minutes,
        start: wallClock(cursor),
        end: wallClock(slotEnd),
      })
      usedMinutes += minutes
      cursor = slotEnd
    }
  }
  return { placed, usedMinutes }
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Date.parse(value)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

/** 生成 service 接受的 wall clock 字符串（YYYY-MM-DDTHH:mm:ss）。 */
function wallClock(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 校验：提案里每条 op 必须在白名单内（防止规划引擎被改成绕过审批）。
 * 供测试与 proposal.preview 前自检使用。
 */
export function assertPlanItemsSafe(items) {
  if (!Array.isArray(items)) throw new TypeError('items 必须是数组')
  for (const item of items) {
    if (!PROPOSAL_ALLOWED_OPS.includes(item?.op)) {
      throw new TypeError(`规划引擎产出了不允许的 op：${String(item?.op)}`)
    }
  }
  return true
}

/**
 * 把去时区的本地墙钟串（wallClock 的输出）补上本机时区偏移，变成合规 ISO 瞬间。
 *
 * 为什么需要：`event.create` 的 start/end 接受本地墙钟串（由事件层按时区解释），
 * 但 `task.dueAt` 走 `isoInstant` 硬校验，必须带 `Z` 或 `±HH:MM`。同一段排期
 * 结果要同时喂给两者，就必须在写回任务时补上偏移。
 *
 * 无效输入返回 undefined——调用方据此跳过回填，绝不产出半截时间串骗过校验。
 */
function withLocalOffset(wall) {
  if (typeof wall !== 'string' || wall === '') return undefined
  // 已经是合规 ISO（带 Z 或偏移）就直接用
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(wall)) {
    return Number.isFinite(Date.parse(wall)) ? wall : undefined
  }
  const parsed = new Date(wall)
  if (Number.isNaN(parsed.getTime())) return undefined
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMin = -parsed.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${wall}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * ScheduleAdapter：把 Event/Task 的提醒统一到一套调度语义上。
 *
 * ## 为什么需要适配层
 *
 * - Event 有起止时间与重复规则；Task 只有「到期时间 + 偏移」。
 * - DSH 原生 `ctx.schedule` 的形态是「一个绝对时刻 + 一段提示文本 + 投递模式」，
 *   它不关心业务对象，只负责**准时投递**。
 * - 所以适配层的职责是：把业务对象编译成 schedule 记录，并把 schedule 的
 *   状态/投递历史**映射回**业务对象；业务侧不需要知道 schedule 的内部形状。
 *
 * ## 幂等键（关键）
 *
 * 每条提醒都有稳定的 `reminderKey = <entityType>:<entityId>:<occurrence>:<offsetMinutes>`。
 * 重复 reconcile 时用这个键做 upsert，保证：
 * - 同一提醒不会因为「服务重启后又算了一遍」而重复投递；
 * - 事件改时间 → 旧键失效、新键建立，旧 schedule 被取消。
 *
 * ## 双后端
 *
 * - `memory`：隔离测试用，把记录放内存并记录「若到点会投递什么」。
 * - `host`：真实 DSH `ctx.schedule`，通过注入的 `create/list/remove/history` 调用。
 *
 * 两种后端实现同一接口，业务代码与测试用同一套断言。
 */

import { createHash } from 'node:crypto'

import { notFoundError, unsupportedError, validationError } from './errors.js'
import { expandEvent } from './recurrence.js'

/** 提醒类型。 */
export const REMINDER_KINDS = Object.freeze(['event-start', 'event-end', 'task-due'])

/** 调度后端名。 */
export const BACKENDS = Object.freeze(['memory', 'host'])

/** 默认提前量（分钟）。 */
export const DEFAULT_LEAD_MINUTES = 15

/**
 * 生成稳定幂等键。
 * @param {{ kind: string, entityId: string, occurrenceKey?: string, offsetMinutes: number }} input
 */
export function reminderKeyOf(input) {
  const raw = [input.kind, input.entityId, input.occurrenceKey ?? '', String(input.offsetMinutes)].join('|')
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * 把一条提醒编译成「绝对触发时刻 + 文案」。
 *
 * @param {{
 *   kind: string, entityId: string, title: string,
 *   atMs: number, offsetMinutes: number, occurrenceKey?: string,
 *   timeZone?: string,
 * }} input
 * @returns {{ reminderKey: string, fireAtMs: number, title: string, prompt: string } | null}
 *   计算出的触发时刻已过去则返回 null（不再补建历史提醒，避免重启后轰炸）。
 */
export function compileReminder(input) {
  if (!REMINDER_KINDS.includes(input.kind)) {
    throw validationError(`未知提醒类型：${input.kind}`, { kind: input.kind, allowed: REMINDER_KINDS })
  }
  if (!Number.isFinite(input.atMs)) {
    throw validationError('提醒的锚点时刻非法', { atMs: input.atMs })
  }
  const offsetMinutes = input.offsetMinutes ?? DEFAULT_LEAD_MINUTES
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0) {
    throw validationError('偏移分钟必须是非负整数', { offsetMinutes })
  }
  const fireAtMs = input.atMs - offsetMinutes * 60 * 1000
  if (!Number.isFinite(fireAtMs)) {
    throw validationError('提醒触发时刻非法', { fireAtMs })
  }
  /**
   * 过期即不建：注释早已承诺「不再补建历史提醒」，这里补上实现。
   * `nowMs` 由调用方给（默认 Date.now），便于测试注入。
   */
  const nowMs = input.nowMs ?? Date.now()
  if (fireAtMs <= nowMs) return null
  return {
    reminderKey: reminderKeyOf({
      kind: input.kind,
      entityId: input.entityId,
      occurrenceKey: input.occurrenceKey,
      offsetMinutes,
    }),
    fireAtMs,
    title: input.title,
    prompt: buildPrompt(input, fireAtMs),
  }
}

function buildPrompt(input, fireAtMs) {
  const when = new Date(fireAtMs).toISOString()
  const body = input.kind === 'task-due' ? `任务「${input.title}」到期` : `日程「${input.title}」即将开始`
  return `${body}（提醒时刻 ${when}${input.offsetMinutes > 0 ? `，提前 ${input.offsetMinutes} 分钟` : ''}）`
}

/**
 * 内存后端：记录「计划中的提醒」，供隔离测试断言。
 * @param {{ now?: () => number }} [options]
 */
export function createMemoryBackend(options = {}) {
  const now = options.now ?? (() => Date.now())
  /** key → record */
  const records = new Map()
  /** 投递历史：{ key, firedAtMs, deliveredAtMs, title } */
  const history = []

  return {
    name: 'memory',
    async upsert(record) {
      records.set(record.reminderKey, { ...record, state: 'scheduled', createdAtMs: now() })
      return { ok: true, reminderKey: record.reminderKey }
    },
    async remove(reminderKey) {
      if (!records.has(reminderKey)) return { ok: false, reason: 'not-found' }
      records.delete(reminderKey)
      return { ok: true }
    },
    async list() {
      return [...records.values()].map((r) => ({ ...r }))
    },
    async get(reminderKey) {
      const found = records.get(reminderKey)
      return found === undefined ? undefined : { ...found }
    },
    /**
     * 模拟「时间到了」：把已到点的提醒记为投递，并从计划中移除。
     * 测试用它验证幂等（重复 tick 不会重复投递）。
     */
    tick(atMs = now()) {
      const delivered = []
      for (const [key, record] of [...records.entries()]) {
        if (record.fireAtMs <= atMs) {
          records.delete(key)
          const entry = { key, fireAtMs: record.fireAtMs, deliveredAtMs: atMs, title: record.title }
          history.push(entry)
          delivered.push(entry)
        }
      }
      return delivered
    },
    async historyList() {
      return history.map((h) => ({ ...h }))
    },
    /** 测试观察用。 */
    snapshot() {
      return { scheduled: [...records.values()].map((r) => ({ ...r })), history: history.map((h) => ({ ...h })) }
    },
  }
}

/**
 * 宿主后端：包装真实 `ctx.schedule`。
 *
 * 注入点（都来自 Host，业务层不自己实现）：
 * @param {{
 *   create: (input: {title: string, prompt: string, at: number, key: string}) => Promise<{id: string}>,
 *   remove: (id: string) => Promise<void>,
 *   list: () => Promise<Array<{id: string, title?: string, scheduledAt?: string, state?: string}>>,
 *   history: () => Promise<Array<{scheduleId?: string, deliveredAt?: string}>>,
 * }} hostSchedule
 */
/**
 * 宿主条目不带 key 时的合成键。
 * 目的不是「精确等价」，而是「同一条提醒两次读到同一个键」，避免重复注册。
 */
function syntheticKey(row) {
  const basis = `${row.title ?? ''}|${row.scheduledAt ?? ''}`
  return `host:${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`
}

export function createHostBackend(hostSchedule) {
  if (hostSchedule === null || typeof hostSchedule !== 'object') {
    throw validationError('host 后端需要注入真实的 ctx.schedule 适配对象')
  }
  for (const fn of ['create', 'remove', 'list']) {
    if (typeof hostSchedule[fn] !== 'function') {
      throw unsupportedError(`host 后端缺少必需方法：${fn}`, { missing: fn })
    }
  }
  /** reminderKey → host schedule id（真实契约里 host 只认自己的 id） */
  const idByKey = new Map()
  const recordByKey = new Map()

  return {
    name: 'host',
    async upsert(record) {
      const existingId = idByKey.get(record.reminderKey)
      if (existingId !== undefined) {
        // 已存在则先取消再重建，避免宿主侧残留旧时刻
        try {
          await hostSchedule.remove(existingId)
        } catch {
          /* 取消失败不阻塞重建；下面的 create 会覆盖映射 */
        }
        idByKey.delete(record.reminderKey)
      }
      const created = await hostSchedule.create({
        title: record.title,
        prompt: record.prompt,
        at: record.fireAtMs,
        key: record.reminderKey,
      })
      idByKey.set(record.reminderKey, created.id)
      recordByKey.set(record.reminderKey, { ...record })
      return { ok: true, reminderKey: record.reminderKey, hostId: created.id }
    },
    async remove(reminderKey) {
      const id = idByKey.get(reminderKey)
      if (id === undefined) return { ok: false, reason: 'not-found' }
      await hostSchedule.remove(id)
      idByKey.delete(reminderKey)
      recordByKey.delete(reminderKey)
      return { ok: true }
    },
    /**
     * 列出「宿主侧实际存在的提醒」。
     *
     * **必须以宿主为准**：进程重启后内存映射是空的，若只看 recordByKey，
     * reconcile 会把「宿主里已存在的提醒」当成不存在而重复 create，
     * 导致每次重启多注册一条、到点重复投递。
     *
     * 宿主条目若带得回 key 就直接用；带不回（真实 ctx.schedule 可能只给 id/title/at）
     * 则按 title+at 反推一个合成 key，至少保证不会对同一条重复 create。
     */
    async list() {
      let hostRows
      try {
        hostRows = await hostSchedule.list()
      } catch {
        // 宿主不可读时退回内存视图（并标记 degraded，由调用方决定是否信任）
        return [...recordByKey.entries()].map(([key, rec]) => ({
          ...rec, hostId: idByKey.get(key), source: 'memory-fallback',
        }))
      }
      const rows = Array.isArray(hostRows) ? hostRows : []
      const out = []
      for (const row of rows) {
        const at = row.scheduledAt === undefined ? undefined : Date.parse(row.scheduledAt)
        const key = row.key ?? syntheticKey(row)
        // 把宿主席位回填到内存映射，后续 upsert/remove 能直接命中
        if (row.id !== undefined && key !== undefined) {
          idByKey.set(key, row.id)
          if (!recordByKey.has(key)) {
            recordByKey.set(key, { reminderKey: key, fireAtMs: Number.isFinite(at) ? at : 0, title: row.title ?? '', prompt: '' })
          }
        }
        out.push({
          reminderKey: key,
          fireAtMs: Number.isFinite(at) ? at : undefined,
          title: row.title ?? '',
          hostId: row.id,
          source: 'host',
        })
      }
      return out
    },
    async get(reminderKey) {
      const rec = recordByKey.get(reminderKey)
      return rec === undefined ? undefined : { ...rec, hostId: idByKey.get(reminderKey) }
    },
    /**
     * 宿主投递历史，映射回**reminderKey**。
     *
     * 恢复逻辑要靠它判断「这条是不是已经投递过」，所以 key 必须是 reminderKey，
     * 不能是宿主的 scheduleId 或空字符串（早期实现取 `row.scheduleId` 导致
     * 已投递提醒被当成未投递而重投，即 Review 的 B2）。
     */
    async historyList() {
      if (typeof hostSchedule.history !== 'function') return []
      const rows = await hostSchedule.history()
      const list = Array.isArray(rows) ? rows : []
      // 反向索引：hostId → reminderKey
      const keyByHostId = new Map()
      for (const [reminderKey, hostId] of idByKey.entries()) keyByHostId.set(hostId, reminderKey)

      return list.map((row) => {
        const explicitKey = typeof row.key === 'string' && row.key !== '' ? row.key : undefined
        const hostId = row.scheduleId ?? row.id
        const mapped = explicitKey ?? keyByHostId.get(hostId) ?? ''
        return {
          key: mapped,
          hostId,
          fireAtMs: row.deliveredAt === undefined ? null : Date.parse(row.deliveredAt),
          title: row.title ?? '',
        }
      })
    },
    snapshot() {
      return {
        scheduled: [...recordByKey.entries()].map(([key, rec]) => ({ ...rec, hostId: idByKey.get(key) })),
        history: [],
      }
    },
  }
}

/**
 * 创建 ScheduleAdapter。
 *
 * @param {{
 *   backend: 'memory'|'host'|object,
 *   now?: () => number,
 *   defaultLeadMinutes?: number,
 *   windowDays?: number,
 * }} options
 */
export function createScheduleAdapter(options) {
  const now = options.now ?? (() => Date.now())
  const defaultLeadMinutes = options.defaultLeadMinutes ?? DEFAULT_LEAD_MINUTES
  const windowDays = options.windowDays ?? 30

  let backend
  if (options.backend === 'memory') backend = createMemoryBackend({ now })
  else if (options.backend === 'host') {
    if (options.hostSchedule === undefined) {
      throw validationError('backend=host 时必须注入 hostSchedule')
    }
    backend = createHostBackend(options.hostSchedule)
  } else if (typeof options.backend === 'object' && options.backend !== null) {
    backend = options.backend
  } else {
    throw validationError(`未知调度后端：${options.backend}`, { backend: options.backend })
  }

  return {
    backendName: backend.name,

    /**
     * 把一组事件编译成提醒计划（不写后端）。
     * @param {Array<object>} events 已归一的 Event
     * @param {{ leadMinutes?: number, includeEnd?: boolean, windowStart?: number, windowEnd?: number }} [opts]
     */
    planForEvents(events, opts = {}) {
      const leadMinutes = opts.leadMinutes ?? defaultLeadMinutes
      const includeEnd = opts.includeEnd === true
      // 可观测：记录被跳过的计划，不再"静默丢光"
      const skipped = []
      const windowStart = opts.windowStart ?? now()
      const windowEnd = opts.windowEnd ?? windowStart + windowDays * 86400000
      const plans = []
      for (const event of events) {
        if (event.status === 'cancelled' || event.deletedAt !== null) continue
        let occurrences
        try {
          occurrences = expandEvent(event, { windowStart, windowEnd })
        } catch (error) {
          // 单条规则不合法不应拖垮整体，但必须可观测
          skipped.push({
            eventId: event.id,
            reason: String(error?.code ?? error?.message ?? error),
          })
          continue
        }
        for (const occ of occurrences) {
          const start = compileReminder({
            kind: 'event-start',
            entityId: event.id,
            title: event.title,
            atMs: occ.startMs,
            offsetMinutes: leadMinutes,
            occurrenceKey: occ.occurrenceKey,
            nowMs: now(),
          })
          if (start !== null) plans.push(start)
          if (includeEnd) {
            const end = compileReminder({
              kind: 'event-end',
              entityId: event.id,
              title: event.title,
              atMs: occ.endMs,
              offsetMinutes: leadMinutes,
              occurrenceKey: occ.occurrenceKey,
              nowMs: now(),
            })
            if (end !== null) plans.push(end)
          }
        }
      }
      Object.defineProperty(plans, 'skipped', { value: skipped, enumerable: false })
      return plans
    },

    /**
     * 把一组任务编译成到期提醒。
     * @param {Array<object>} tasks 形如 { id, title, dueAt?: string, done?: boolean }
     */
    planForTasks(tasks, opts = {}) {
      const leadMinutes = opts.leadMinutes ?? defaultLeadMinutes
      const plans = []
      for (const task of tasks) {
        if (task.done === true || task.dueAt === undefined || task.dueAt === null) continue
        const dueMs = Date.parse(task.dueAt)
        if (!Number.isFinite(dueMs)) continue
        const plan = compileReminder({
          kind: 'task-due',
          entityId: String(task.id),
          title: task.title ?? String(task.id),
          atMs: dueMs,
          offsetMinutes: leadMinutes,
          nowMs: now(),
        })
        if (plan !== null) plans.push(plan)
      }
      return plans
    },

    /**
     * 用计划对齐后端：upsert 新计划、取消不再需要的旧提醒。
     * **幂等**：同一计划重复 reconcile 不产生重复提醒。
     *
     * @param {Array<{reminderKey: string, fireAtMs: number, title: string, prompt: string}>} plans
     * @param {{ scope?: string }} [opts] scope 用于区分「这批计划负责的范围」
     */
    async reconcile(plans, opts = {}) {
      const desired = new Map()
      for (const plan of plans) desired.set(plan.reminderKey, plan)

      /**
       * scope：只对「本批次负责的那部分」做增删。
       *
       * 不给 scope 时保持全量语义（向后兼容）；给了就只看 reminderKey 以
       * `<scope>:` 开头的条目，避免「只恢复事件」把任务提醒顺手删光。
       */
      const scope = opts.scope
      const inScope = (key) => (scope === undefined ? true : String(key).startsWith(`${scope}:`))

      const existing = await backend.list()
      const existingKeys = new Set(existing.map((r) => r.reminderKey).filter(inScope))

      const created = []
      const updated = []
      const removed = []

      for (const [key, plan] of desired) {
        if (!existingKeys.has(key)) {
          await backend.upsert(plan)
          created.push(key)
        } else {
          const current = await backend.get(key)
          if (current === undefined || current.fireAtMs !== plan.fireAtMs) {
            await backend.upsert(plan)
            updated.push(key)
          }
        }
      }
      for (const key of existingKeys) {
        if (!desired.has(key)) {
          await backend.remove(key)
          removed.push(key)
        }
      }
      return { created, updated, removed, total: desired.size }
    },

    /** 列出当前计划中的提醒。 */
    list() {
      return backend.list()
    },

    /** 取单条。 */
    get(reminderKey) {
      return backend.get(reminderKey)
    },

    /** 取消单条提醒。 */
    async cancel(reminderKey) {
      const res = await backend.remove(reminderKey)
      if (res.ok !== true) throw notFoundError(`提醒不存在：${reminderKey}`, { reminderKey })
      return res
    },

    /** 调度历史（真实投递记录）。 */
    history() {
      return backend.historyList()
    },

    /**
     * 测试辅助：内存后端的时间推进。
     *
     * 只在 `backend === 'memory'` 时可用；自定义/host 后端一律拒绝，
     * 避免把「时间旅行」这种测试能力当成业务能力泄漏出去。
     */
    _tick(atMs) {
      if (options.backend !== 'memory' || typeof backend.tick !== 'function') {
        throw unsupportedError('tick 仅 memory 后端可用（测试专用）')
      }
      return backend.tick(atMs)
    },

    /** 测试辅助：观察后端快照。 */
    _snapshot() {
      return backend.snapshot()
    },
  }
}

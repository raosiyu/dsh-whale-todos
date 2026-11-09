/**
 * ScheduleAdapter：把 Event/Task 的提醒统一到一套调度语义上。
 *
 * ## 契约依据
 *
 * 宿主侧一切形状以 `docs/wp2/05-host-contract.md` 为准（逐行取自
 * `@deepseek-ai/dsh-schedule@0.2.1-rc.5/lib/index.js`）。任何与此不符的调用都是缺陷。
 *
 * ## 三条硬纪律
 *
 * 1. **不用 `list()` 判存在性** —— 它只返回 `active`；一次性提醒投递后转
 *    `inactive` 但行仍在，用 `list` 会把「已投递」误判成「从未存在」→ 重复投递。
 *    判存在性一律用 `catalog()`。
 * 2. **不许静默 catch** —— 宿主异常必须上抛或显式降级为 `degraded`，
 *    不得伪造成「后端为空」。
 * 3. **不许用 `title + scheduledAt` 当身份** —— 同标题同刻的两条不同提醒会撞键。
 *    身份只来自 `host-map.js` 持久化的 `reminderKey ↔ hostId` 映射。
 *
 * ## 幂等键
 *
 * `reminderKey = sha256(kind|entityId|occurrenceKey|offsetMinutes)`，稳定且唯一。
 * 与宿主 id 的对应关系落盘，重启从磁盘恢复。
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

/** 宿主读取状态：显式区分「读到了」与「读不到」，不谎报。 */
export const HOST_READ = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'unavailable',
})

/**
 * 生成稳定幂等键。
 * @param {{ kind: string, entityId: string, occurrenceKey?: string, offsetMinutes: number }} input
 */
export function reminderKeyOf(input) {
  const raw = [input.kind, input.entityId, input.occurrenceKey ?? '', String(input.offsetMinutes)].join('|')
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * 把毫秒瞬时转成宿主要求的 canonical RFC3339 UTC 字符串。
 *
 * 宿主约束（契约 §二）：必须是 `YYYY-MM-DDTHH:mm:ss.sssZ`，且字面等于
 * `new Date(epoch).toISOString()`；`at` 传数字会被判 `invalid_rule`。
 */
export function toHostInstant(ms) {
  if (!Number.isFinite(ms)) throw validationError('提醒触发时刻非法', { ms })
  return new Date(ms).toISOString()
}

/**
 * 把一条提醒编译成「绝对触发时刻 + 文案」。
 *
 * @returns {{ reminderKey, fireAtMs, title, prompt } | null}
 *   已过期返回 null（不补建历史提醒）。
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
  const records = new Map()
  const deliveryHistory = []

  return {
    name: 'memory',
    async catalog() {
      return {
        status: HOST_READ.OK,
        degraded: false,
        rows: [...records.values()].map((r) => ({
          id: r.reminderKey,
          reminderKey: r.reminderKey,
          sessionId: r.sessionId ?? '',
          status: r.status ?? 'active',
          fireAtMs: r.fireAtMs,
          title: r.title,
        })),
      }
    },
    async upsert(record) {
      records.set(record.reminderKey, { ...record, status: 'active' })
      return { ok: true, reminderKey: record.reminderKey }
    },
    async remove(reminderKey) {
      if (!records.has(reminderKey)) return { ok: false, reason: 'not-found' }
      records.delete(reminderKey)
      return { ok: true }
    },
    async get(reminderKey) {
      const found = records.get(reminderKey)
      return found === undefined ? undefined : { ...found }
    },
    /**
     * 模拟到点投递：从计划移除，但**保留投递读取能力**
     * （对应宿主 inactive 仍在 catalog 的语义）。
     */
    tick(atMs = now()) {
      const delivered = []
      for (const [key, record] of [...records.entries()]) {
        if (record.fireAtMs <= atMs) {
          records.delete(key)
          const entry = { key, fireAtMs: record.fireAtMs, deliveredAtMs: atMs, title: record.title }
          deliveryHistory.push(entry)
          delivered.push(entry)
        }
      }
      return delivered
    },
    async historyFor(reminderKey) {
      const rows = deliveryHistory.filter((h) => h.key === reminderKey)
      return { status: HOST_READ.OK, records: rows.map((r) => ({ deliveredAtMs: r.deliveredAtMs })) }
    },
    snapshot() {
      return {
        scheduled: [...records.values()].map((r) => ({ ...r })),
        history: deliveryHistory.map((h) => ({ ...h })),
      }
    },
  }
}

/**
 * 宿主后端：严格包装真实 `ctx.schedule`。
 *
 * 注入的方法必须与契约一致（**不接受任何简化形状**）：
 * @param {{
 *   create: (sessionId: string, request: {title: string, prompt: string, at: string}, signal?: AbortSignal) => Promise<object>,
 *   list: (request: {sessionId: string}) => Promise<object[]>,
 *   catalog: () => Promise<object[]>,
 *   history: (request: {sessionId: string, id: string, limit: number}) => Promise<object>,
 *   delete: (request: {id: string, sessionId: string}, signal?: AbortSignal) => Promise<object>,
 * }} hostSchedule 真实 ctx.schedule（或同形状的 contract stub）
 * @param {{ hostMap: object, sessionId: string }} options
 */
export function createHostBackend(hostSchedule, options) {
  if (hostSchedule === null || typeof hostSchedule !== 'object') {
    throw validationError('host 后端需要注入真实 ctx.schedule 适配对象')
  }
  for (const fn of ['create', 'list', 'catalog', 'history', 'delete']) {
    if (typeof hostSchedule[fn] !== 'function') {
      throw unsupportedError(`host 后端缺少必需方法：${fn}（见 docs/wp2/05-host-contract.md）`, { missing: fn })
    }
  }
  const hostMap = options?.hostMap
  if (hostMap === undefined || hostMap === null) {
    throw validationError('host 后端需要持久化映射表（hostMap），否则重启后无法识别提醒归属')
  }
  const sessionId = options?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw validationError('host 后端需要 sessionId：宿主所有方法都绑定会话')
  }

  let lastCatalogError

  /**
   * 同 key 的创建锁：reminderKey → Promise。
   *
   * 并发 reconcile 时，同一提醒的创建必须排队，否则会重复建——
   * 复审探针 09 实测 20 个并发 reconcile 会在宿主侧建出 20 条同一提醒（用户收到 20 次）。
   * 根因是「读 catalog → 判断不存在 → create」的读-改-写竞态。
   */
  const createLocks = new Map()

  const readCatalog = async () => {
    try {
      const rows = await hostSchedule.catalog()
      lastCatalogError = undefined
      if (!Array.isArray(rows)) {
        throw validationError('宿主 catalog 返回非数组', { got: typeof rows })
      }
      return { status: HOST_READ.OK, rows }
    } catch (error) {
      // 纪律 2：不静默吞；记录原因并显式返回 UNAVAILABLE，由调用方拒绝危险动作。
      lastCatalogError = error
      return { status: HOST_READ.UNAVAILABLE, error }
    }
  }

  const backend = {
    name: 'host',

    /** 最近一次 catalog 失败原因（诊断用）。 */
    get lastError() {
      return lastCatalogError
    },

    /**
     * 列出「本 session 在宿主侧真实存在」的提醒。
     *
     * 用 `catalog()` 而非 `list()`：必须看见 inactive，否则已投递的会被当成不存在
     * 而被重建（这正是 B2 的机制）。归属只从持久化映射翻译，**绝不靠 title+at 猜**。
     */
    async catalog() {
      const read = await readCatalog()
      if (read.status !== HOST_READ.OK) {
        return { status: HOST_READ.UNAVAILABLE, error: read.error, rows: [], degraded: true }
      }
      const mine = read.rows.filter((row) => row.sessionId === undefined || row.sessionId === sessionId)
      const out = []
      /**
       * **N-03**：宿主行在本地映射里找不到 → 无法确定归属。
       * 原实现静默 `continue`，后果是：映射丢条目/丢文件后，同一提醒在宿主侧
       * 已有 1 份，适配器看不见 → reconcile 又建 1 份 → 变 2 份；旧行成孤儿
       * 仍会投递，且 `cancel` 报 not-found。
       *
       * 现在把它收集到 `unmapped` 随结果返回，由上层告警；**仍然不认领**
       * （不能猜归属），但至少不再无声无息。
       */
      const unmapped = []
      // **一次性建表**做身份反查：逐行调用 reminderKeyByHostId 会退化成
      // O(宿主行 × 映射条目)（实测 2000 条时对账耗时不可接受）。
      const lookup = typeof hostMap.hostIdLookup === 'function'
        ? hostMap.hostIdLookup()
        : null
      for (const row of mine) {
        // 身份反查：条目可能被裁剪，但身份索引仍在 → 仍能认出宿主上的行，
        // 因此不会因为裁剪而重复创建（P3 探针发现的缺陷）。
        const reminderKey = lookup !== null
          ? lookup.get(row.id)
          : (typeof hostMap.reminderKeyByHostId === 'function'
            ? hostMap.reminderKeyByHostId(row.id)
            : undefined)
        if (reminderKey === undefined) {
          unmapped.push({ id: row.id, scheduledAt: row.scheduledAt, title: row.title })
          continue
        }
        const mapped = typeof hostMap.describe === 'function'
          ? (hostMap.describe(reminderKey) ?? { reminderKey, sessionId, fireAtMs: 0, title: '', scope: '' })
          : (hostMap.get(reminderKey) ?? { reminderKey, sessionId, fireAtMs: 0, title: '', scope: '' })
        const at = row.scheduledAt === undefined ? NaN : Date.parse(row.scheduledAt)
        out.push({
          id: row.id,
          reminderKey,
          sessionId: mapped.sessionId ?? sessionId,
          scope: mapped.scope ?? '',
          status: row.status ?? 'active',
          scheduledAt: row.scheduledAt,
          fireAtMs: Number.isFinite(at) ? at : (mapped.fireAtMs ?? 0),
          title: row.title ?? mapped.title ?? '',
          source: 'host',
        })
      }
      return {
        status: HOST_READ.OK,
        rows: out,
        degraded: false,
        unmapped,
        // 上层应据此告警：宿主有记录但我们认不出归属
        needsAttention: unmapped.length > 0,
      }
    },

    /** 兼容接口：仅 active（不得用于存在性判断）。 */
    async list() {
      const res = await backend.catalog()
      return res.rows.filter((r) => r.status === 'active')
    },

    async get(reminderKey) {
      const res = await backend.catalog()
      return res.rows.find((r) => r.reminderKey === reminderKey)
    },

    /**
     * 建立或更新一条提醒。
     *
     * - 已存在且时刻一致 → 幂等复用，不重建；
     * - 已存在但时刻不同 → 删旧建新；
     * - catalog 读不到 → **拒绝**，不盲目补建（纪律 2）。
     */
    /**
     * 同 key 的创建**串行化**：后一个等待前一个完成后再判断，从而只会建一条。
     * 不同 key 之间仍然并行。
     */
    async upsert(record) {
      const previous = createLocks.get(record.reminderKey) ?? Promise.resolve()
      let release
      const gate = new Promise((resolve) => { release = resolve })
      createLocks.set(record.reminderKey, previous.then(() => gate))
      await previous
      try {
        return await this.upsertLocked(record)
      } finally {
        release()
      }
    },

    async upsertLocked(record) {
      const current = await backend.catalog()
      if (current.status !== HOST_READ.OK) {
        return { ok: false, reason: 'host-unavailable', error: current.error }
      }
      const existing = current.rows.find((r) => r.reminderKey === record.reminderKey)

      if (existing !== undefined && existing.status === 'active' && existing.fireAtMs === record.fireAtMs) {
        return { ok: true, reminderKey: record.reminderKey, hostId: existing.id, reused: true }
      }
      if (existing !== undefined) {
        const del = await hostSchedule.delete({ id: existing.id, sessionId })
        if (del?.deleted !== true) {
          return { ok: false, reason: 'delete-failed', hostId: existing.id, result: del }
        }
        hostMap.remove(record.reminderKey)
      }

      /**
       * **N-04**：`create` 可能因宿主侧校验失败而抛（例如标题超过 120 字符时
       * `invalid_prompt`——本地 5000 字符也允许，宿主只收 120）。
       * 若不捕获，一次失败会让**整轮 reconcile/recover 中断**，且已建的部分半途而废。
       * 改为返回 `{ok:false}`，由主循环逐条决策。
       */
      let created
      try {
        created = await hostSchedule.create(sessionId, {
          title: record.title,
          prompt: record.prompt,
          at: toHostInstant(record.fireAtMs),
        })
      } catch (error) {
        return {
          ok: false,
          reason: 'host-create-rejected',
          code: error?.code,
          message: String(error?.message ?? error),
        }
      }
      if (created === null || typeof created !== 'object' || typeof created.id !== 'string') {
        return {
          ok: false,
          reason: 'host-create-invalid-result',
          got: created === null ? 'null' : typeof created,
        }
      }
      hostMap.put({
        reminderKey: record.reminderKey,
        hostId: created.id,
        sessionId,
        fireAtMs: record.fireAtMs,
        title: record.title,
        kind: record.kind ?? 'unknown',
        scope: typeof record.scope === 'string' ? record.scope : '',
      })
      /**
       * 身份必须**立刻落盘**：若这里崩了而身份没写下去，重启后
       * 认不出宿主上这条 → 重建 → 用户收到两次。
       * 这条路径低频（每条提醒一次），全量写可接受。
       */
      if (typeof hostMap.flush === 'function') hostMap.flush()
      return { ok: true, reminderKey: record.reminderKey, hostId: created.id }
    },

    async remove(reminderKey) {
      // **B-1 修复**：条目被裁成「墓碑」后 hostMap.get() 返回 undefined，
      // 但身份索引仍能给出 hostId。用 hostIdOf 兜住，否则用户取消的提醒
      // 永远删不掉 —— 宿主侧留下幽灵提醒继续响。
      const mapped = typeof hostMap.describe === 'function'
        ? hostMap.describe(reminderKey)
        : hostMap.get(reminderKey)
      if (mapped === undefined) return { ok: false, reason: 'not-found' }
      const res = await hostSchedule.delete({ id: mapped.hostId, sessionId })
      if (res?.deleted === true) {
        hostMap.remove(reminderKey)
        if (typeof hostMap.flush === 'function') hostMap.flush()
        return { ok: true }
      }
      if (res?.code === 'schedule_not_found') {
        // 宿主侧已不存在：清本地映射，视作已删除
        hostMap.remove(reminderKey)
        if (typeof hostMap.flush === 'function') hostMap.flush()
        return { ok: true, alreadyGone: true }
      }
      /**
       * 删除**失败**（宿主报错/返回异常）：**保留身份**。
       *
       * 若此时清掉身份映射，宿主上那条提醒就变成了「我们认不出的孤儿」：
       * 下次对账认不出它 → 重建 → 用户收到两次；而它其实还在宿主上。
       */
      return { ok: false, reason: 'delete-failed', result: res }
    },

    /**
     * 查某条提醒的投递历史。
     *
     * 真实签名 `history({sessionId, id, limit})`：**单任务、分页**。
     * 返回显式三态；读不到时返回 UNAVAILABLE（UNKNOWN），绝不谎报「没投递过」。
     */
    async historyFor(reminderKey) {
      const mapped = hostMap.get(reminderKey)
      if (mapped === undefined) return { status: HOST_READ.OK, records: [] }
      let res
      try {
        res = await hostSchedule.history({ sessionId, id: mapped.hostId, limit: 100 })
      } catch (error) {
        return { status: HOST_READ.UNAVAILABLE, error }
      }
      if (res?.code === 'schedule_not_found') {
        return { status: HOST_READ.OK, records: [] }
      }
      /**
       * **形状校验**：宿主返回的不是对象（异常形状）时，
       * **不能**当成「没投递过」——那会重建提醒并二次投递。
       *
       * 无法确认投递状态 = UNKNOWN，交由恢复流程保守处理（不重建、不删除）。
       */
      if (res === null || typeof res !== 'object' || Array.isArray(res)) {
        return { status: HOST_READ.UNAVAILABLE, error: 'history-invalid-shape' }
      }
      /**
       * **宿主侧 status/error 形状识别**（复审探针 01）。
       *
       * 宿主（或中间层）可能返回 `{status:'unavailable', error:…}` 这类形状。
       * 若把它当成「合法但没有记录」，就会判成未投递 → 重建 → **二次投递**。
       * 这里把非 ok 的 status 一律映射为 UNAVAILABLE（= UNKNOWN，保守处理）。
       */
      if (
        (typeof res.status === 'string' && res.status !== 'ok')
        || (res.error !== undefined && res.records === undefined)
      ) {
        return { status: HOST_READ.UNAVAILABLE, error: res.error ?? res.status ?? 'host-history-unavailable' }
      }
      const records = Array.isArray(res?.records) ? res.records : []
      return {
        status: HOST_READ.OK,
        records: records.map((r) => ({
          scheduledAt: r.scheduledAt,
          deliveredAt: r.deliveredAt,
          messageId: r.messageId,
        })),
        earlierRecordsUnavailable: res?.earlierRecordsUnavailable === true,
      }
    },

    snapshot() {
      return { scheduled: hostMap.entries(), history: [] }
    },
  }

  return backend
}

/**
 * 创建 ScheduleAdapter。
 *
 * @param {{
 *   backend: 'memory'|'host'|object,
 *   now?: () => number,
 *   defaultLeadMinutes?: number,
 *   windowDays?: number,
 *   hostSchedule?: object,
 *   hostMap?: object,
 *   sessionId?: string,
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
      throw validationError('backend=host 时必须注入 hostSchedule（真实 ctx.schedule 形状）')
    }
    backend = createHostBackend(options.hostSchedule, {
      hostMap: options.hostMap,
      sessionId: options.sessionId,
    })
  } else if (typeof options.backend === 'object' && options.backend !== null) {
    backend = options.backend
  } else {
    throw validationError(`未知调度后端：${options.backend}`, { backend: options.backend })
  }

  const adapter = {
    backendName: backend.name,
    sessionId: options.sessionId,

    /**
     * 编译事件提醒。返回 `{ plans, skipped }`——**用普通对象而非非枚举属性**，
     * 以免经 spread / JSON / 日志时静默丢失（第二轮 Review 的 m3）。
     */
    planForEvents(events, opts = {}) {
      const leadMinutes = opts.leadMinutes ?? defaultLeadMinutes
      const includeEnd = opts.includeEnd === true
      const windowStart = opts.windowStart ?? now()
      const windowEnd = opts.windowEnd ?? windowStart + windowDays * 86400000
      const plans = []
      const skipped = []
      for (const event of events) {
        if (event.status === 'cancelled' || event.deletedAt !== null) continue
        let occurrences
        try {
          occurrences = expandEvent(event, {
            windowStart,
            windowEnd,
            monthEndPolicy: opts.monthEndPolicy ?? 'rfc',
          })
        } catch (error) {
          skipped.push({ eventId: event.id, reason: String(error?.code ?? error?.message ?? error) })
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
      return { plans, skipped }
    },

    planForTasks(tasks, opts = {}) {
      const leadMinutes = opts.leadMinutes ?? defaultLeadMinutes
      const plans = []
      const skipped = []
      for (const task of tasks) {
        /**
         * 「没填截止时间」与「填了但解析不了」是两件事，不能混为一谈：
         * - 空串 / 空白串 / null / undefined = **没填** → 不提醒，也不报警。
         *   界面新建待办时 dueAt 就是空串，把它当坏数据报警等于对正常操作报假警。
         * - 非空但 Date.parse 得 NaN = **填错** → 进 skipped，必须让人看见。
         */
        const dueRaw = task.dueAt
        const dueIsBlank = dueRaw === undefined || dueRaw === null
          || (typeof dueRaw === 'string' && dueRaw.trim() === '')
        if (task.done === true || dueIsBlank) continue
        const dueMs = Date.parse(dueRaw)
        if (!Number.isFinite(dueMs)) {
          skipped.push({ taskId: String(task.id), reason: 'invalid-dueAt' })
          continue
        }
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
      return { plans, skipped }
    },

    /** 宿主侧真实存在（含 inactive）的提醒。 */
    async catalog() {
      if (typeof backend.catalog !== 'function') {
        return { status: HOST_READ.OK, rows: [], degraded: false }
      }
      return backend.catalog()
    },

    /**
     * 用计划对齐后端。
     *
     * **安全降级**：宿主读不到时**只建不删**（宁可有重复，不可删用户提醒），
     * 并返回 `degraded: true` 让调用方告警。绝不把「读不到」当成「没有」。
     *
     * @param {Array} plans
     * @param {{ scope?: string }} [opts]
     */
    async reconcile(plans, opts = {}) {
      const desired = new Map()
      for (const plan of plans) desired.set(plan.reminderKey, plan)

      /**
       * **受保护的 key**：本轮**不得删除**。
       *
       * 场景（第四轮 Review 探针 p1 抓到，是我修 N-02 时引入的回归）：
       * 投递状态 UNKNOWN（宿主 history 抛错，或回执被 retention 裁剪）时，
       * 恢复流程不把该 plan 放进 `future`。若 `reconcile` 只看「不在 desired
       * 里就删」，这条宿主上**仍然 active、仍然有效**的提醒会被删掉——
       * 用户从此再也收不到它。
       *
       * 「不重建」不等于「删掉」。UNKNOWN 的正确处置是：**原样保留，不动**。
       */
      const protect = new Set(Array.isArray(opts.protect) ? opts.protect : [])

      /**
       * **scope 按映射字段过滤**（M3'/N-11 修复）。
       *
       * 旧实现 `String(key).startsWith(`${scope}:`)` 对裸 sha256 key 永不成立，
       * 于是"给了 scope"等于"什么也不算在内"，隔离实际失效。
       * 现在用 `catalog()` 行上的 `scope` 字段比较；不给 scope 时保持全量语义。
       */
      const scope = opts.scope
      const inScopeRow = (row) => (scope === undefined ? true : row.scope === scope)

      const cat = await adapter.catalog()
      const degraded = cat.status !== HOST_READ.OK

      /**
       * 只把 **active** 的记录纳入「可删除」范围。
       *
       * 已投递的一次性提醒会转 `inactive` 但行仍在（契约 §五）。它此刻必然
       * 不在 `desired` 里（因为 `compileReminder` 会滤掉过期项），若参与差量
       * 删除就会被清掉——**投递记录随之丢失**，重启后无法再判定「这条已提醒过」，
       * 于是又被重建、重复投递（第二轮 Review 的 B2 根因）。
       *
       * 所以：inactive 一律保留。它不会再响，删它没有功能收益，只有历史损失。
       */
      const activeKeys = degraded
        ? new Set()   // 读不到就不知道有哪些：只建不删
        : new Set(
            cat.rows
              .filter((r) => (r.status ?? 'active') === 'active')
              .filter(inScopeRow)
              .map((r) => r.reminderKey),
          )
      const existingKeys = activeKeys

      const created = []
      const updated = []
      const removed = []
      const failed = []

      for (const [key, plan] of desired) {
        // 单条失败不得中断整轮（N-04）
        // reconcile 的 scope 落到 plan 上，供 upsert 写进映射
        const scopedPlan = scope === undefined ? plan : { ...plan, scope }
        try {
          if (!existingKeys.has(key)) {
            const res = await backend.upsert(scopedPlan)
            if (res.ok === true) (res.reused === true ? updated : created).push(key)
            else failed.push({ key, reason: res.reason, code: res.code })
            continue
          }
          const current = await backend.get(key)
          if (current === undefined || current.fireAtMs !== plan.fireAtMs) {
            const res = await backend.upsert(scopedPlan)
            if (res.ok === true) updated.push(key)
            else failed.push({ key, reason: res.reason, code: res.code })
          }
        } catch (error) {
          failed.push({ key, reason: 'exception', message: String(error?.message ?? error) })
        }
      }

      if (!degraded) {
        for (const key of existingKeys) {
          if (desired.has(key)) continue
          if (protect.has(key)) continue   // UNKNOWN：保留不动
          // N-08：删除失败不能静默吞掉，必须计入 failed 让调用方看见
          const res = await backend.remove(key)
          if (res.ok === true) removed.push(key)
          else failed.push({ key, reason: res.reason ?? 'delete-failed', op: 'remove' })
        }
      }

      return {
        created, updated, removed, failed,
        protected: [...protect],
        total: desired.size,
        degraded,
      }
    },

    async list() {
      const cat = await adapter.catalog()
      return cat.rows
    },

    get(reminderKey) {
      return backend.get(reminderKey)
    },

    async cancel(reminderKey) {
      const res = await backend.remove(reminderKey)
      if (res.ok !== true) {
        throw notFoundError(`提醒不存在或取消失败：${reminderKey}`, {
          reminderKey,
          reason: res.reason,
        })
      }
      return res
    },

    /** 某条提醒的投递历史（显式三态，不谎报）。 */
    historyFor(reminderKey) {
      if (typeof backend.historyFor !== 'function') {
        return Promise.resolve({ status: HOST_READ.UNAVAILABLE, error: 'backend-without-history' })
      }
      return backend.historyFor(reminderKey)
    },

    _tick(atMs) {
      if (options.backend !== 'memory' || typeof backend.tick !== 'function') {
        throw unsupportedError('tick 仅 memory 后端可用（测试专用）')
      }
      return backend.tick(atMs)
    },

    _snapshot() {
      return backend.snapshot()
    },
  }

  return adapter
}

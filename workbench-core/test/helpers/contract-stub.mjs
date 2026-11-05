/**
 * **真实契约 stub**（contract stub）：按 `@deepseek-ai/dsh-schedule@0.2.1-rc.5`
 * 的真实签名实现，**签名不对就当场抛错**。
 *
 * ## 为什么需要它
 *
 * WP2 两轮修复都栽在同一处：用自造的简化接口（`create({at: number})` 单参、
 * `list()` 无参）验证「通过」，真实宿主下全线 TypeError。
 *
 * 这个 stub 的作用是把真实契约**变成可执行的断言**：
 * - `create` 必须是两参，`request.at` 必须是 canonical RFC3339 字符串，
 *   否则抛 `invalid_rule`（与真实现一致，L2084/L186-206）；
 * - `list` 必须带 `{sessionId}`，否则抛错（L2120）；
 * - `history` 必须带 `{sessionId, id, limit∈[1,100]}`，否则抛 `invalid_rule`（L2144-2145）；
 * - `delete` 必须带 `{id, sessionId}`（L2164）；
 * - 一次性提醒投递后转 `inactive` 但**行仍在**，因此 `catalog()` 看得见、`list()` 看不见
 *   （L1599-1626）——这是 B2 的真实机制，必须模拟。
 *
 * ## 与真实现的差别（诚实声明）
 *
 * 这是**行为模拟**，不是真宿主：不复现存储域事务、并发队列、Session 投递。
 * 它验证的是**调用形状与状态语义**，真实集成另由隔离 profile 验证。
 */

const UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/
const OFFSET_INSTANT = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/

/** 复刻 ScheduleInputError 的可判定 code。 */
export class StubInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ScheduleInputError'
    this.code = code
  }
}

/**
 * 复刻 `parseAtInput`：只接受字符串 + 真实日历时刻（L186-206）。
 * @returns {number} epoch ms
 */
export function parseAtStrict(value) {
  if (typeof value !== 'string') {
    // 真实现：request.at 非字符串时走解析，必然抛 invalid_rule
    throw new StubInputError('invalid_rule', 'at must be a string in RFC 3339 form')
    }
  if (UTC_INSTANT.test(value)) {
    const epoch = Date.parse(value)
    if (!Number.isFinite(epoch)) throw new StubInputError('invalid_rule', 'at is not a real instant')
    return epoch
  }
  const groups = OFFSET_INSTANT.exec(value)?.groups
  if (groups === undefined) {
    throw new StubInputError('invalid_rule', 'at must use YYYY-MM-DDTHH:mm:ss with explicit Z or numeric offset')
  }
  const parts = {
    year: Number(groups.year), month: Number(groups.month), day: Number(groups.day),
    hour: Number(groups.hour), minute: Number(groups.minute), second: Number(groups.second),
    ms: groups.fraction === undefined ? 0 : Number(groups.fraction.padEnd(3, '0')),
  }
  // 复刻 calendarEpoch 的反归一化检查：2 月 30 日这种必须被拒
  const probe = new Date(0)
  probe.setUTCHours(0, 0, 0, 0)
  probe.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  probe.setUTCHours(parts.hour, parts.minute, parts.second, parts.ms)
  if (probe.getUTCFullYear() !== parts.year || probe.getUTCMonth() + 1 !== parts.month
      || probe.getUTCDate() !== parts.day || probe.getUTCHours() !== parts.hour
      || probe.getUTCMinutes() !== parts.minute || probe.getUTCSeconds() !== parts.second) {
    throw new StubInputError('invalid_rule', 'the at value must be a real calendar date and time')
  }
  let epoch = probe.getTime()
  if (groups.zone !== 'Z') {
    const oh = Number(groups.offsetHour)
    const om = Number(groups.offsetMinute)
    if (oh > 23 || om > 59) throw new StubInputError('invalid_rule', 'the at offset is invalid')
    epoch -= (groups.sign === '+' ? 1 : -1) * (oh * 60 + om) * 60000
  }
  return epoch
}

/**
 * 创建严格契约 stub。
 *
 * @param {{ now?: () => number }} [options]
 */
export function createContractStub(options = {}) {
  const now = options.now ?? (() => Date.now())
  /** id → { record, sessionId, status, deliveryHistory } */
  const tasks = new Map()
  let seq = 0
  /** 记录每一次非法调用，供测试断言「契约被遵守」 */
  const violations = []

  const violation = (method, message, extra = {}) => {
    violations.push({ method, message, ...extra })
    throw new StubInputError('invalid_rule', `${method}: ${message}`)
  }

  const requireSessionId = (method, sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      violation(method, 'sessionId must be a non-empty string', { got: typeof sessionId })
    }
  }

  const stub = {
    /** 契约违规记录（测试用）。 */
    get violations() {
      return [...violations]
    },

    /** 直接读取内部状态（测试断言用，不属宿主契约）。 */
    _tasks: tasks,

    /**
     * `create(sessionId, request, signal)` —— **两参**。
     * `request.at` 必须是 canonical RFC3339 字符串。
     */
    async create(sessionId, request, signal) {
      requireSessionId('create', sessionId)
      if (request === null || typeof request !== 'object') {
        violation('create', 'request must be an object', { got: typeof request })
      }
      const selectors = ['at', 'after_seconds', 'every_seconds', 'daily', 'weekly', 'cron']
        .filter((k) => request[k] !== undefined)
      if (selectors.length !== 1) {
        throw new StubInputError('invalid_selector', 'exactly one reminder selector is required')
      }
      if (typeof request.title !== 'string' || request.title.trim() === '') {
        throw new StubInputError('invalid_prompt', 'title is required and must be non-empty after trimming.')
      }
      const title = request.title.trim()
      if (title.length > 120) throw new StubInputError('invalid_prompt', 'title must be at most 120 characters.')
      if (typeof request.prompt !== 'string' || request.prompt === '' || request.prompt.trim() !== request.prompt) {
        throw new StubInputError('invalid_prompt', 'prompt must be non-empty and already trimmed')
      }
      signal?.throwIfAborted?.()

      let scheduledAt
      if (request.at !== undefined) {
        const epoch = parseAtStrict(request.at)
        if (epoch <= now()) throw new StubInputError('not_future', 'the scheduled time must be strictly in the future.')
        scheduledAt = new Date(epoch).toISOString()
        if (!UTC_INSTANT.test(scheduledAt)) {
          throw new StubInputError('time_out_of_range', 'scheduled time must be representable as four-digit-year UTC')
        }
      } else {
        throw new StubInputError('invalid_selector', 'only the at selector is stubbed')
      }

      const id = `schedule-${++seq}`
      const record = Object.freeze({ id, kind: 'at', title, prompt: request.prompt, scheduledAt })
      tasks.set(id, {
        sessionId,
        record,
        status: 'active',
        deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      return record
    },

    /** `list({sessionId})` —— 必须带 sessionId，只返回 active。 */
    async list(request) {
      if (request === null || typeof request !== 'object') {
        violation('list', 'request must be {sessionId}')
      }
      requireSessionId('list', request.sessionId)
      return [...tasks.values()]
        .filter((t) => t.sessionId === request.sessionId && t.status === 'active')
        .map((t) => t.record)
    },

    /** `catalog()` —— 无参，返回全部（含 inactive）。 */
    async catalog() {
      return [...tasks.values()]
        .map((t) => ({
          ...t.record,
          sessionId: t.sessionId,
          status: t.status,
          ...(t.lastDelivery === undefined ? {} : { lastDelivery: t.lastDelivery }),
        }))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
    },

    /** `history({sessionId, id, limit})` —— 单任务、limit ∈ [1,100]。 */
    async history(request) {
      if (request === null || typeof request !== 'object') {
        violation('history', 'request must be {sessionId, id, limit}')
      }
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new StubInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
      }
      requireSessionId('history', request.sessionId)
      const task = tasks.get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, code: 'schedule_not_found' }
      }
      const records = [...task.deliveryHistory.records].reverse().slice(0, request.limit)
      return {
        records,
        earlierRecordsUnavailable: task.deliveryHistory.earlierRecordsUnavailable,
      }
    },

    /** `delete({id, sessionId})`。 */
    async delete(request, signal) {
      if (request === null || typeof request !== 'object') {
        violation('delete', 'request must be {id, sessionId}')
      }
      requireSessionId('delete', request.sessionId)
      signal?.throwIfAborted?.()
      const task = tasks.get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      tasks.delete(request.id)
      return { id: request.id, deleted: true }
    },

    /**
     * 测试辅助：模拟到点投递。
     *
     * 复刻真实语义（L1599-1626）：**转 inactive 但行仍在**，
     * 因此 `list()` 看不到、`catalog()` 看得到。这正是 B2 的机制。
     */
    tick(atMs = now()) {
      const delivered = []
      for (const [id, task] of tasks.entries()) {
        if (task.status !== 'active') continue
        const at = Date.parse(task.record.scheduledAt)
        if (at <= atMs) {
          const receipt = {
            scheduledAt: task.record.scheduledAt,
            deliveredAt: new Date(atMs).toISOString(),
            messageId: `msg-${id}`,
          }
          task.status = 'inactive'
          task.lastDelivery = receipt
          task.deliveryHistory = {
            records: [...task.deliveryHistory.records, receipt],
            earlierRecordsUnavailable: false,
          }
          delivered.push({ id, ...receipt })
        }
      }
      return delivered
    },
  }

  return stub
}

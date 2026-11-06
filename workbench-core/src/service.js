/**
 * 统一业务服务入口。
 *
 * ## 为什么要"统一入口"
 *
 * UI 动作和 Agent 工具必须调用**同一个**方法（DSH `user-actions.md` 的硬要求），
 * 否则两条路径的状态机迟早分叉。这里用 `execute(op, payload, meta)` 做唯一入口：
 * - 统一参数校验（每个 op 自带校验器）
 * - 统一危险操作审批（delete / bulk / import / replace 需要 `confirmed: true`）
 * - 统一审计（所有写操作落 audit）
 * - 统一错误语义（WorkbenchError.code）
 *
 * ## Task 与 Event 的关系
 *
 * 共用本门面，但**不共用存储行**：Task 走 `tasks` 集合，Event 走 `events` 集合。
 * 本包**不迁移、不改写**任何既有 Task 数据（Dely0 的 `~/.dsh/workbench` SQLite 一律不碰）；
 * `tasks` 集合在本包里是"新建的、空的"，只有显式 `task.upsert` 才会写入。
 * 这是"共用入口但不动既有数据"的具体落地方式。
 */

import { createHash, randomUUID } from 'node:crypto'

import { conflictError, confirmationRequired, notFoundError, unsupportedError, validationError } from './errors.js'
import { checkEventConflicts, findConflicts, findFreeSlots } from './conflict.js'
import { WALL_PATTERN, addDaysToDate, dateToUtcMs, daysBetween, instantToWall, wallToInstant } from './time.js'
import { AUDIT_ACTIONS, createEventRepo } from './event-repo.js'
import { expandEvent, expandEvents } from './recurrence.js'
import { buildIcs, exportJson, parseIcs, parseJsonSnapshot } from './ics.js'
import { approvalFingerprint, createHostApprovalGate } from './approval-gate.js'
import { createHistoryOps } from './history.js'
import { createScheduleAdapter, DEFAULT_LEAD_MINUTES } from './schedule-adapter.js'
import { openStore } from './store.js'
import { validateEventInput } from './event.js'

/** 拖拽移动支持的范围（「此后所有」需要 RRULE 分段，本版本明确不提供）。 */
export const MOVABLE_MODES = Object.freeze(['single', 'series'])

/** 需要显式确认的危险操作。 */
export const DANGEROUS_OPS = Object.freeze([
  'event.delete',
  'event.bulkDelete',
  'event.import',
  'snapshot.replace',
  'store.rollback',
  /**
   * **N-06**：这两个也是写操作——`event.restore` 能撤销软删、`task.upsert`
   * 能覆盖既有任务。原清单漏了它们，导致 `deny` 模式下仍可改数据。
   */
  'event.restore',
  /**
   * `task.upsert` 覆盖既有任务属于危险写，但**新建与完成**是授权要求的正常路径，
   * 一律要求审批会阻断「快速创建/完成待办」。
   * 因此审批按**语义**触发：仅**软删**（deleted/deletedAt）时校验凭证；
   * 覆盖与新建不阻断 —— 软删是唯一破坏性操作。
   */
  'task.upsert',
])

/**
 * **N-05**：`deny` 模式下**所有写操作**都必须拒绝，不只危险清单里的。
 *
 * 原实现只对 `DANGEROUS_OPS` 调审批校验，`gate.writable` 从未被读取，
 * 于是 deny 模式下 `event.create` / `event.update` / `store.backup` 全部放行——
 * "deny" 名不副实。
 */
export const WRITE_OPS = Object.freeze([
  'event.create', 'event.update', 'event.restore', 'event.delete', 'event.bulkDelete',
  'event.import', 'task.upsert', 'snapshot.replace', 'store.rollback', 'store.backup',
  /**
   * 撤销/重做会改数据，deny 模式下必须一并拒绝。
   * 它们**不进** DANGEROUS_OPS：撤销是用户的正常补救手段，
   * 一律要求审批会让「按 Cmd+Z」变成一次弹窗风暴。
   */
  'history.undo', 'history.redo',
  // WP5 新增的写操作
  'event.move', 'task.reorder', 'task.archive',
])

/**
 * 创建服务。
 * @param {{ dataDir: string, now?: () => Date, idFactory?: () => string }} options
 */
export function createWorkbenchService(options) {
  const store = openStore(options.dataDir, {
    now: options.now,
    historyLimit: options.historyLimit,
  })
  const events = createEventRepo(store, { now: options.now, idFactory: options.idFactory })
  const now = options.now ?? (() => new Date())
  /**
   * 默认时区：全天事件不带 timeZone 时用它补齐，避免"存 UTC、读本地"造成偏移。
   * 缺省 UTC（跨时区仍读作同一本地日），调用方应按用户所在时区传入。
   */
  const defaultTimeZone = options.defaultTimeZone ?? 'UTC'

  /** 全天事件补齐默认时区；定时事件不动（它必须显式带 timeZone）。 */
  const withDefaultZone = (input) => {
    if (input !== null && typeof input === 'object' && !Array.isArray(input)
        && input.allDay === true && input.timeZone === undefined) {
      return { ...input, timeZone: defaultTimeZone }
    }
    return input
  }

  /**
   * 审批门：**危险操作只认宿主签发的 token，不认 payload 里的 confirmed**。
   *
   * 这是 WP2 的硬约束：AI 能自己填 `confirmed: true`，所以那个字段没有任何
   * 授权含义。真正的授权来自 `approvalGate`：由宿主（或测试注入的 issuer）
   * 签发一次性凭证，服务层校验指纹 + 有效期 + 未使用后才放行。
   */
  const gate = options.approvalGate ?? createHostApprovalGate({
    mode: options.approvalMode ?? 'host',
    allowIsolated: options.allowIsolatedApproval === true,
    request: options.requestApproval,
    now: options.nowApproval,
  })

  const requireConfirmation = (op, meta, detail = {}) => {
    if (!DANGEROUS_OPS.includes(op)) return
    const check = gate.verify(
      { op, target: detail.target, digest: detail.digest },
      meta?.approvalToken,
    )
    if (!check.ok) {
      throw confirmationRequired(
        `危险操作 ${op} 需要宿主审批凭证（原因：${check.reason}）；payload 里的 confirmed 不被采信`,
        { op, reason: check.reason },
      )
    }
  }

  /**
   * 内容摘要：**由服务层自己算**，绝不信任调用方传进来的 digest。
   *
   * 早期实现让调用方传 `digest`（例如 `String(text.length)`）作为指纹的一部分，
   * 这是可绕过的：两段等长但内容不同的 ICS 会得到同一指纹，攻击者可用
   * 「批准 A 文件」的凭证去导入「等长的 B 文件」。这里改为对**实际内容**取
   * SHA-256，调用方无法用长度之类弱信息冒充。
   */
  const contentDigest = (text) =>
    createHash('sha256').update(String(text), 'utf8').digest('hex')

  /** 供调用方（UI 或 Agent 工具）先申请审批，再带 token 调用 execute。 */
  const requestApproval = async (op, detail = {}) => {
    if (!DANGEROUS_OPS.includes(op)) {
      return { approved: true, token: undefined, reason: 'op-not-requiring-approval' }
    }
    // 内容类操作：摘要必须由内容本身算，调用方传入的 digest 不参与
    const digest = typeof detail.text === 'string' ? contentDigest(detail.text) : detail.digest
    /**
     * bulkDelete 的 target 由 id 集合推导（JSON），与 execute 侧完全一致。
     * 调用方传 `ids` 即可，不必知道内部编码。
     */
    const target = op === 'event.bulkDelete' && Array.isArray(detail.ids)
      ? JSON.stringify([...detail.ids].map(String).sort())
      : detail.target
    return gate.request({
      op,
      target,
      digest,
      summary: detail.summary ?? op,
    })
  }

  const ops = {
    // ---- 查询 -------------------------------------------------------------
    'event.list': (payload = {}) => {
      const includeDeleted = payload.includeDeleted === true
      const rows = includeDeleted ? events.list() : events.listActive()
      return rows.map((row) => structuredClone(row))
    },

    'event.get': (payload) => {
      const id = requireId(payload, 'id')
      return events.get(id)
    },

    'event.expand': (payload) => {
      const windowStart = requireNumber(payload, 'windowStart')
      const windowEnd = requireNumber(payload, 'windowEnd')
      const rows = events.listActive()
      return expandEvents(rows, { windowStart, windowEnd })
    },

    'event.freeSlots': (payload) => {
      const windowStart = requireNumber(payload, 'windowStart')
      const windowEnd = requireNumber(payload, 'windowEnd')
      const rows = events.listActive()
      return findFreeSlots(rows, {
        windowStart,
        windowEnd,
        minSlotMs: payload.minSlotMs,
        bufferMs: payload.bufferMs,
        allDayBlocks: payload.allDayBlocks === true,
      })
    },

    'event.conflicts': (payload) => {
      const windowStart = requireNumber(payload, 'windowStart')
      const windowEnd = requireNumber(payload, 'windowEnd')
      const rows = events.listActive()
      const instances = expandEvents(rows, { windowStart, windowEnd })
      return findConflicts(instances, { allDayBlocks: payload.allDayBlocks === true })
    },

    // ---- 写入 -------------------------------------------------------------
    'event.create': (payload, meta) => {
      const input = validateEventInput(withDefaultZone(payload?.event ?? payload))
      const preview = checkEventConflicts(events.listActive(), {
        id: '__candidate__',
        ...input,
        uid: '__candidate__',
        status: 'confirmed',
        tags: input.tags ?? [],
      }, { allowOverlap: payload?.allowOverlap === true, allDayBlocks: payload?.allDayBlocks === true })
      if (preview.blocking) {
        throw conflictError('存在时间冲突', { conflicts: preview.conflicts.map((c) => ({ a: c.a.eventId, b: c.b.eventId, overlapMs: c.overlapMs })) })
      }
      const created = events.create(input, { actor: meta?.actor })
      return { event: created, conflicts: preview.conflicts }
    },

    'event.update': (payload, meta) => {
      const id = requireId(payload, 'id')
      const patch = payload.patch ?? {}
      const updated = events.update(id, patch, { actor: meta?.actor })
      return { event: updated }
    },

    /**
     * **拖拽移动（WP5）**。
     *
     * 语义必须显式，不允许猜：
     * - 非重复事件：`mode` 只能是 `series`（等价于整体移动）；给 `single` 直接报错。
     * - 重复事件：必须显式 `single`（只改这一次）或 `series`（改整个系列）。
     * - `thisAndFuture`（此后所有）**明确拒绝** —— 本数据模型没有 RRULE 分段，
     *   假装支持会写出一份语义错误的日历。
     *
     * `single` 的实现是 RRULE 的 EXDATE 语义：把原日期写进 `excludeDates`，
     * 再新建一个**非重复**事件承载新时间（保留原事件的所有其他字段）。
     * 这样系列其余实例完全不动，且可被再次查询/编辑/删除。
     */
    'event.move': (payload, meta) => {
      const id = requireId(payload, 'id')
      const mode = payload?.mode ?? 'series'
      const target = payload?.target ?? {}
      if (!MOVABLE_MODES.includes(mode)) {
        throw unsupportedError(
          `不支持的移动范围：${mode}（只支持 ${MOVABLE_MODES.join(' / ')}；「此后所有」需要 RRULE 分段，本版本不提供）`,
          { mode, supported: [...MOVABLE_MODES] },
        )
      }
      const current = events.find(id)
      if (current === null) throw notFoundError(`事件不存在：${id}`, { id })

      const isRecurring = current.recurrence !== null && current.recurrence !== undefined
      if (mode === 'single' && !isRecurring) {
        throw validationError('非重复事件没有「只改这一次」的语义，请用 mode=series', { id, mode })
      }

      const conflictsOf = (candidate) => {
        const preview = checkEventConflicts(events.listActive().filter((row) => row.id !== id), {
          id: '__candidate__',
          ...candidate,
          uid: '__candidate__',
          status: 'confirmed',
          tags: candidate.tags ?? [],
        }, {
          allowOverlap: payload?.allowOverlap === true,
          allDayBlocks: payload?.allDayBlocks === true,
        })
        return preview
      }

      if (mode === 'series') {
        const patch = {}
        if (current.allDay) {
          const date = target.startDate
          if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw validationError('全天事件移动必须给 target.startDate（YYYY-MM-DD）', { target })
          }
          const deltaDays = daysBetween(current.startDate, date)
          patch.startDate = date
          if (current.endDate !== null && current.endDate !== undefined) {
            patch.endDate = addDaysToDate(current.endDate, deltaDays)
          }
          // excludeDates 是日期集合，整体平移才与系列保持一致
          if (Array.isArray(current.excludeDates) && current.excludeDates.length > 0) {
            patch.excludeDates = current.excludeDates.map((d) => addDaysToDate(d, deltaDays))
          }
        } else {
          const start = target.start ?? target.startDate
          if (typeof start !== 'string' || !WALL_PATTERN.test(start)) {
            throw validationError('非全天事件移动必须给 target.start（YYYY-MM-DDTHH:mm）', { target })
          }
          const deltaMs = wallToInstant(start, current.timeZone).ms - wallToInstant(current.start, current.timeZone).ms
          patch.start = start
          if (current.end !== null && current.end !== undefined) {
            patch.end = instantToWall(wallToInstant(current.end, current.timeZone).ms + deltaMs, current.timeZone)
          }
          if (typeof target.timeZone === 'string' && target.timeZone !== current.timeZone) {
            patch.timeZone = target.timeZone
          }
        }
        // 先算候选（合并后）再落盘：冲突时**不写**，前端据此恢复原位
        const candidate = { ...current, ...patch }
        const preview = conflictsOf(candidate)
        if (preview.blocking) {
          throw conflictError('移动目标存在时间冲突', {
            conflicts: preview.conflicts.map((c) => ({ a: c.a.eventId, b: c.b.eventId, overlapMs: c.overlapMs })),
          })
        }
        const moved = events.update(id, patch, { actor: meta?.actor })
        return { moved, mode, event: moved, conflicts: preview.conflicts }
      }

      // mode === 'single'：EXDATE + 独立事件
      const occurrenceDate = payload?.occurrenceDate
      if (typeof occurrenceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
        throw validationError('「只改这一次」必须给 occurrenceDate（被拖动的那个实例的日期）', { payload })
      }
      const windowAround = (date) => {
        const dayMs = 86400000
        const center = dateToUtcMs(date)
        return { windowStart: center - dayMs * 2, windowEnd: center + dayMs * 2, monthEndPolicy: 'rfc' }
      }
      const instances = expandEvent(current, windowAround(occurrenceDate))
      const hit = instances.find((occ) => (occ.startDate ?? new Date(occ.startMs).toISOString().slice(0, 10)) === occurrenceDate)
      if (hit === undefined) {
        throw validationError(`该日期不是这个系列的实际实例：${occurrenceDate}`, { id, occurrenceDate })
      }

      // 新时间：沿用原实例的时长，起点取 target
      const baseEvent = current.allDay
        ? { allDay: true, startDate: target.startDate, timeZone: current.timeZone }
        : {
            allDay: false,
            start: target.start ?? target.startDate,
            timeZone: target.timeZone ?? current.timeZone,
            end: null,
          }
      if (current.allDay) {
        if (typeof baseEvent.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(baseEvent.startDate)) {
          throw validationError('全天事件移动必须给 target.startDate（YYYY-MM-DD）', { target })
        }
      } else {
        if (typeof baseEvent.start !== 'string' || !WALL_PATTERN.test(baseEvent.start)) {
          throw validationError('非全天事件移动必须给 target.start（YYYY-MM-DDTHH:mm）', { target })
        }
        // 保留原时长
        const durationMs = hit.endMs - hit.startMs
        baseEvent.end = instantToWall(wallToInstant(baseEvent.start, baseEvent.timeZone).ms + durationMs, baseEvent.timeZone)
      }

      const candidate = {
        title: current.title,
        description: current.description,
        location: current.location,
        importance: current.importance,
        tags: current.tags,
        source: 'local',
        ...baseEvent,
        recurrence: undefined,
      }
      const validated = validateEventInput(withDefaultZone(candidate))
      const preview = conflictsOf(validated)
      if (preview.blocking) {
        throw conflictError('移动目标存在时间冲突', {
          conflicts: preview.conflicts.map((c) => ({ a: c.a.eventId, b: c.b.eventId, overlapMs: c.overlapMs })),
        })
      }

      // 原子：排除原实例 + 建新实例，两步在同一次 mutate 里
      const backup = store.backup('before-event-move-single')
      /**
       * 单次移动是「排除 + 新建」两步，必须折叠成**一条**撤销 ——
       * 否则用户按一次 Cmd+Z 只撤掉新建那条，原实例还处于被排除状态，
       * 结果是「这次约会凭空消失」。
       */
      const undoDepthBefore = (store.read().undo ?? []).length
      const beforeState = {
        events: structuredClone(store.read().events ?? []),
        tasks: structuredClone(store.read().tasks ?? []),
      }
      try {
        const excluded = events.update(id, {
          excludeDates: [...new Set([...(current.excludeDates ?? []), occurrenceDate])].sort(),
        }, { actor: meta?.actor })
        const created = events.create(validated, { actor: meta?.actor })
        store.collapseUndo(undoDepthBefore, 'event.move:single', beforeState)
        return { moved: created, mode, event: excluded, created, occurrenceDate, conflicts: preview.conflicts }
      } catch (error) {
        store.rollback(backup.path.split('/').pop())
        throw error
      }
    },

    'event.delete': (payload, meta) => {
      const id = requireId(payload, 'id')
      requireConfirmation('event.delete', meta, { target: id })
      return events.remove(id, { actor: meta?.actor })
    },

    'event.restore': (payload, meta) => {
      const id = requireId(payload, 'id')
      /**
       * `event.restore` 能撤销软删 = 危险写，且它**在** DANGEROUS_OPS 里，
       * 但原实现**从不**调 requireConfirmation —— 终审实测：无凭证即可把已删事件
       * 悄悄恢复（审计里 actor 是未授权的 'attacker'）。
       * 这是与 task.upsert 同样的遗漏，这里补齐。
       */
      requireConfirmation('event.restore', meta, { target: id })
      return events.restore(id, { actor: meta?.actor })
    },

    'event.bulkDelete': (payload, meta) => {
      const ids = payload?.ids
      if (!Array.isArray(ids) || ids.length === 0) {
        throw validationError('ids 必须是非空数组')
      }
      /**
       * target 用 **JSON.stringify(sortedIds)**，不用逗号拼接。
       *
       * 第二轮 Review 的 N3'：`join(',')` 让 `['a,b']` 与 `['a','b']` 撞同一串，
       * 一份批量删除凭证可覆盖另一个 id 集合。JSON 消除该歧义。
       */
      requireConfirmation('event.bulkDelete', meta, {
        target: JSON.stringify([...ids].map(String).sort()),
      })
      const results = []
      for (const id of ids) {
        results.push(events.remove(String(id), { actor: meta?.actor }))
      }
      return { deleted: results }
    },

    // ---- 导入导出 ---------------------------------------------------------
    /**
     * **ICS 导入预览（WP5 增强）**。
     *
     * 授权要求预览必须显示：新增 / 重复 / 冲突 / 不支持 四类。
     * 原实现只给 create 与 skip，冲突与不支持都不体现 —— 用户看不到风险就点了导入。
     *
     * 逐条 plan 带 `action`：
     *   - `create`：新增
     *   - `skip-duplicate-uid`：同 UID 已存在（重复）
     *   - `conflict`：与既有日程时间重叠（仍可导入，但必须让用户看到）
     * 另附 `unsupported` 清单（结构化，逐条可定位）。
     */
    'event.previewIcs': (payload) => {
      const text = requireString(payload, 'text')
      const parsed = parseIcs(text, { defaultTimeZone: payload.defaultTimeZone })
      const existing = events.listActive()
      const plan = parsed.events.map((incoming) => {
        const sameUid = existing.find((row) => (row.uid ?? row.id) === (incoming.uid ?? incoming.id))
        if (sameUid !== undefined) {
          return {
            action: 'skip-duplicate-uid',
            uid: incoming.uid ?? null,
            title: incoming.title,
            allDay: incoming.allDay === true,
            startDate: incoming.startDate ?? null,
            start: incoming.start ?? null,
            timeZone: incoming.timeZone ?? null,
            conflictWith: [],
          }
        }
        // 冲突检测：只对能通过校验的条目做，避免把非法输入当成冲突
        let conflictWith = []
        try {
          const validated = validateEventInput(withDefaultZone(incoming))
          const preview = checkEventConflicts(existing, {
            id: '__candidate__',
            ...validated,
            uid: '__candidate__',
            status: 'confirmed',
            tags: validated.tags ?? [],
          }, { allDayBlocks: payload?.allDayBlocks === true })
          conflictWith = preview.conflicts.map((c) => c.a.eventId)
        } catch {
          conflictWith = []
        }
        return {
          action: conflictWith.length > 0 ? 'conflict' : 'create',
          uid: incoming.uid ?? null,
          title: incoming.title,
          allDay: incoming.allDay === true,
          startDate: incoming.startDate ?? null,
          start: incoming.start ?? null,
          timeZone: incoming.timeZone ?? null,
          conflictWith,
          degraded: incoming.degraded === true,
        }
      })
      return {
        plan,
        counts: {
          create: plan.filter((x) => x.action === 'create').length,
          duplicate: plan.filter((x) => x.action === 'skip-duplicate-uid').length,
          conflict: plan.filter((x) => x.action === 'conflict').length,
          degraded: plan.filter((x) => x.degraded === true).length,
          unsupported: (parsed.unsupported ?? []).length,
          // 兼容既有调用方
          skip: plan.filter((x) => x.action !== 'create').length,
        },
        unsupported: parsed.unsupported ?? [],
        warnings: parsed.warnings,
        errors: parsed.errors,
      }
    },

    'event.import': (payload, meta) => {
      const text = requireString(payload, 'text')
      requireConfirmation('event.import', meta, { digest: contentDigest(text) })
      const parsed = parseIcs(text, { defaultTimeZone: payload.defaultTimeZone })
      if (parsed.errors.length > 0) {
        throw validationError('ICS 存在无法解析的条目，已中止导入', { errors: parsed.errors })
      }
      const backup = store.backup('before-ics-import')
      /**
       * **导入折叠成一条撤销**（WP5）：内部逐条 create 会在栈里堆 N 条，
       * 用户得按 N 次 Cmd+Z 才能撤掉一次导入。记下开始前的栈深与数据，
       * 成功后就地合成一条。
       */
      const undoDepthBefore = (store.read().undo ?? []).length
      const beforeState = {
        events: structuredClone(store.read().events ?? []),
        tasks: structuredClone(store.read().tasks ?? []),
      }
      const created = []
      try {
        for (const incoming of parsed.events) {
          const validated = validateEventInput(withDefaultZone(incoming))
          created.push(events.create(validated, { actor: meta?.actor }))
        }
      } catch (error) {
        store.rollback(backup.path.split('/').pop())
        throw error
      }
      store.mutate((draft) => {
        draft.audit.push({
          id: (options.idFactory ?? (() => randomUUID()))(),
          at: now().toISOString(),
          action: AUDIT_ACTIONS.IMPORT,
          entity: 'event',
          entityId: null,
          actor: meta?.actor ?? 'user',
          after: { count: created.length, source: 'ics' },
        })
        return draft
      }, { intent: 'event.import' })
      /**
       * **折叠必须放在最后**：审计那条 mutate 自己也会入栈，
       * 先折叠再写审计会留下两条（实测：导入 3 条 → 栈深 +2）。
       */
      store.collapseUndo(undoDepthBefore, 'event.import', beforeState)
      return { imported: created.length, events: created, warnings: parsed.warnings, backup }
    },

    'event.exportIcs': (payload = {}) => {
      const rows = payload.includeDeleted === true ? events.list() : events.listActive()
      const text = buildIcs(rows, { calendarName: payload.calendarName })
      return { text, count: rows.length }
    },

    'snapshot.export': (payload = {}) => {
      const snapshot = store.read()
      const text = exportJson(snapshot, {
        exportedAt: now().toISOString(),
        fingerprint: store.fingerprint(),
      })
      return { text, fingerprint: store.fingerprint() }
    },

    /**
     * **JSON 快照预览（WP5 增强）**。
     *
     * 与 ICS 预览同构：新增 / 重复 / 不支持 三类必须逐条可见。
     * `replace` 是**覆盖式**导入，所以「会被删掉的既有条目」也必须算出来 ——
     * 用户点确认前有权知道这一下会丢多少东西。
     */
    'snapshot.preview': (payload) => {
      const text = requireString(payload, 'text')
      const parsed = parseJsonSnapshot(text)
      const currentEvents = events.list()
      const currentTasks = store.collection('tasks')
      const currentEventIds = new Set(currentEvents.map((row) => row.id))
      const currentTaskIds = new Set(currentTasks.map((row) => row.id))
      const incomingEventIds = new Set(parsed.events.map((row) => row.id))
      const incomingTaskIds = new Set(parsed.tasks.map((row) => row.id))

      // 覆盖式导入会移除「库里有、快照里没有」的条目
      const removedEvents = currentEvents.filter((row) => !incomingEventIds.has(row.id)).map((row) => row.id)
      const removedTasks = currentTasks.filter((row) => !incomingTaskIds.has(row.id)).map((row) => row.id)

      const unsupported = []
      for (const row of parsed.events) {
        if (typeof row.id !== 'string' || row.id === '') {
          unsupported.push({ kind: 'event', detail: String(row.title ?? '(无标题)'), reason: '缺少合法 id' })
        }
      }
      for (const row of parsed.tasks) {
        if (typeof row.id !== 'string' || row.id === '') {
          unsupported.push({ kind: 'task', detail: String(row.title ?? '(无标题)'), reason: '缺少合法 id' })
        }
      }

      return {
        events: parsed.events.length,
        tasks: parsed.tasks.length,
        newEvents: parsed.events.filter((row) => !currentEventIds.has(row.id)).length,
        newTasks: parsed.tasks.filter((row) => !currentTaskIds.has(row.id)).length,
        duplicateEvents: parsed.events.filter((row) => currentEventIds.has(row.id)).length,
        duplicateTasks: parsed.tasks.filter((row) => currentTaskIds.has(row.id)).length,
        removedEvents,
        removedTasks,
        counts: {
          create: parsed.events.filter((row) => !currentEventIds.has(row.id)).length
            + parsed.tasks.filter((row) => !currentTaskIds.has(row.id)).length,
          duplicate: parsed.events.filter((row) => currentEventIds.has(row.id)).length
            + parsed.tasks.filter((row) => currentTaskIds.has(row.id)).length,
          removed: removedEvents.length + removedTasks.length,
          unsupported: unsupported.length,
        },
        unsupported,
        warnings: parsed.warnings,
      }
    },

    'snapshot.replace': (payload, meta) => {
      const text = requireString(payload, 'text')
      requireConfirmation('snapshot.replace', meta, { digest: contentDigest(text) })
      const parsed = parseJsonSnapshot(text)
      const backup = store.backup('before-snapshot-replace')
      const undoDepthBefore = (store.read().undo ?? []).length
      const beforeState = {
        events: structuredClone(store.read().events ?? []),
        tasks: structuredClone(store.read().tasks ?? []),
      }
      try {
        store.replace({
          version: 1,
          updatedAt: now().toISOString(),
          events: parsed.events,
          tasks: parsed.tasks,
          audit: store.read().audit,
        })
      } catch (error) {
        store.rollback(backup.path.split('/').pop())
        throw error
      }
      store.collapseUndo(undoDepthBefore, 'snapshot.replace', beforeState)
      return { replaced: { events: parsed.events.length, tasks: parsed.tasks.length }, backup }
    },

    // ---- 撤销 / 重做（WP5）------------------------------------------------
    ...createHistoryOps(store, {
      now,
      idFactory: options.idFactory,
      limit: options.historyLimit,
    }),

    // ---- 存储运维 ---------------------------------------------------------
    'store.backup': (payload = {}) => store.backup(payload.label ?? 'manual'),
    'store.listBackups': () => store.listBackups(),
    'store.rollback': (payload, meta) => {
      /**
       * **审批必须在查数据之前**。
       *
       * 否则无凭证的调用者能从 `not-found`（没有备份）与 `confirmation-required`
       * 的差异里推断出库内状态——审批门成了信息探测器。
       *
       * 同时指纹仍绑定**具体备份名**（N4）：不接受 `'latest'` 这种会在审批后
       * 前移的目标。调用方必须显式给 `name`；不给就取「当前最新」并把它写进
       * 指纹，之后若出现更新的备份，指纹自然不匹配 → 拒绝，而不是悄悄换目标。
       */
      const declared = payload?.name
      if (typeof declared !== 'string' || declared === '') {
        throw validationError('store.rollback 必须显式指定 name（不接受隐式 latest）', {
          reason: 'explicit-target-required',
        })
      }
      requireConfirmation('store.rollback', meta, { target: declared })
      const backups = store.listPreBackups()
      if (!backups.includes(declared)) {
        throw notFoundError(`备份不存在：${declared}`, { targetName: declared })
      }
      return store.rollback(declared)
    },
    'store.audit': (payload = {}) => events.auditLog({ entityId: payload.entityId }),

    // ---- Task 门面（不改既有数据，只做统一入口） ---------------------------
    /**
     * 列出待办。**默认过滤已删除**（deleted/deletedAt），与 Event 侧
     * `listActive()` 的语义一致（event-repo.js:170-172）。
     *
     * 复审发现：软删后待办仍出现在列表里 → 删除功能对用户完全无效。
     */
    /**
     * **只读**：把「接下来要提醒什么」算出来给 UI 显示。
     *
     * 为什么是只读：真实投递必须由宿主 `ctx.schedule` 负责（WP3 契约），
     * 服务层只负责「该提醒哪些、什么时候提醒」的计算。让 UI 显示提醒
     * 不等于让 UI 能投递——这是两件事，不能混。
     *
     * 不写数据、不触发审批、不进 WRITE_OPS。
     */
    'reminder.plan': (payload = {}) => {
      const leadMinutes = payload.leadMinutes ?? DEFAULT_LEAD_MINUTES
      if (!Number.isInteger(leadMinutes) || leadMinutes < 0) {
        throw validationError('leadMinutes 必须是非负整数', { leadMinutes })
      }
      const nowMs = payload.nowMs ?? now().getTime()
      if (!Number.isFinite(nowMs)) {
        throw validationError('nowMs 非法', { nowMs })
      }
      const windowDays = payload.windowDays ?? 7
      const adapter = createScheduleAdapter({
        backend: 'memory',
        now: () => nowMs,
        defaultLeadMinutes: leadMinutes,
        windowDays,
      })
      const ev = store.collection('events')
      const tk = store.collection('tasks')
      const evPlan = adapter.planForEvents(ev, {
        leadMinutes,
        windowStart: nowMs,
        windowEnd: nowMs + windowDays * 86400000,
      })
      const tkPlan = adapter.planForTasks(tk, { leadMinutes })
      const plans = [...evPlan.plans, ...tkPlan.plans]
        .sort((a, b) => a.fireAtMs - b.fireAtMs)
      /**
       * skipped 必须原样上抛，不能静默吞掉——「算不出提醒」和
       * 「没有提醒」是两回事，前者要让人看见。
       */
      return {
        plans,
        skipped: [...evPlan.skipped, ...tkPlan.skipped],
        leadMinutes,
        windowDays,
        nowMs,
      }
    },
    'task.list': (payload = {}) => {
      const includeDeleted = payload.includeDeleted === true
      return store.collection('tasks')
        .filter((task) => includeDeleted || !isTaskDeleted(task))
    },
    'task.upsert': (payload, meta) => {
      const task = payload?.task
      if (task === null || typeof task !== 'object' || Array.isArray(task)) {
        throw validationError('task 必须是对象')
      }
      if (typeof task.id !== 'string' || task.id === '') {
        throw validationError('task.id 必须是非空字符串')
      }
      const existingTask = store.collection('tasks').find((row) => row.id === task.id)
      /**
       * **条件审批**（复审 MAJOR 修复 + 收口复审 NEW-2 修复）：
       *
       * 复审发现软删绕过审批门（`task.upsert` 从不调 requireConfirmation，
       * token 可伪造）。但不能一律审批——新建待办是正常路径（授权要求
       * 「快速创建」「创建和完成待办」顺畅），一律要审批会把体验打崩。
       *
       * 语义：
       *   - **新建**待办 → 不需要审批
       *   - **编辑/完成**既有待办 → 不需要审批
       *   - **软删**待办 → 需要审批（破坏性）
       *
       * 软删判定必须看**两边**：
       *   - 入参声明软删（deleted/deletedAt）
       *   - **库中既有行已经是软删**（否则可用不带 deleted 的 payload
       *     无凭证把已删待办「复活」= 撤销一次软删，与 event.restore 同语义）
       */
      const declaredSoftDelete = task.deleted === true
        || (typeof task.deletedAt === 'string' && task.deletedAt !== '')
      const existingSoftDelete = existingTask !== undefined && isTaskDeleted(existingTask)
      if (declaredSoftDelete || existingSoftDelete) {
        requireConfirmation('task.upsert', meta, { target: task.id })
      }
      store.mutate((draft) => {
        const index = draft.tasks.findIndex((row) => row.id === task.id)
        if (index < 0) draft.tasks.push({ ...task })
        else {
          /**
           * **合并语义**（收口复审 NEW-1 修复）：
           * 整行替换会抹掉调用方没提供的字段 —— AI 工具只有 id/title/dueAt/done，
           * 于是 priority/status/subtasks/sourceSessionId 全丢（静默数据丢失）。
           * 对照 `event.update` 的 mergePatch 白名单：这里也只覆盖**显式提供**的字段。
           */
          const merged = { ...draft.tasks[index] }
          for (const [k, v] of Object.entries(task)) {
            if (v !== undefined) merged[k] = v
          }
          draft.tasks[index] = merged
        }
        draft.audit.push({
          id: (options.idFactory ?? (() => randomUUID()))(),
          at: now().toISOString(),
          action: index < 0 ? 'task.create' : 'task.update',
          entity: 'task',
          entityId: task.id,
          actor: meta?.actor ?? 'user',
        })
        return draft
      }, { intent: 'task.upsert' })
      // 返回**库中合并后的完整行**：原实现只回显入参，调用方会误读为「字段丢了」
      const stored = store.collection('tasks').find((row) => row.id === task.id)
      return { task: structuredClone(stored ?? task) }
    },

    /**
     * **拖拽排序（WP5）**。
     *
     * 传**完整的目标顺序**而不是「把 A 挪到 B 前面」：后者需要服务端重建整个序列，
     * 一旦并发或客户端状态陈旧就会算出用户没看到的顺序。传全量则幂等、可校验。
     *
     * `scope` 限定排序范围（默认全部）：同一 project 内排序不会影响别的分组。
     * 只改 `order` 字段，**不碰任何其它字段**（授权明令禁止排序丢字段）。
     */
    'task.reorder': (payload, meta) => {
      const ids = payload?.ids
      if (!Array.isArray(ids) || ids.length === 0) {
        throw validationError('ids 必须是非空数组（完整的目标顺序）')
      }
      const normalized = [...ids].map(String)
      if (new Set(normalized).size !== normalized.length) {
        throw validationError('ids 里不能有重复项', { ids: normalized })
      }
      const project = payload?.project
      const rows = store.collection('tasks')
      const missing = normalized.filter((id) => !rows.some((row) => row.id === id))
      if (missing.length > 0) {
        throw validationError('存在未知的待办 id，排序未生效', { missing })
      }
      // scope 校验：给了 project 就必须只排该分组内的待办
      if (project !== undefined) {
        const outsiders = normalized.filter((id) => {
          const row = rows.find((r) => r.id === id)
          return (row.project ?? null) !== project
        })
        if (outsiders.length > 0) {
          throw validationError('ids 必须都属于同一分组', { project, outsiders })
        }
      }
      const orderOf = new Map(normalized.map((id, index) => [id, index]))
      store.mutate((draft) => {
        for (const row of draft.tasks) {
          const next = orderOf.get(row.id)
          if (next !== undefined) row.order = next
        }
        draft.audit.push({
          id: (options.idFactory ?? (() => randomUUID()))(),
          at: now().toISOString(),
          action: 'task.reorder',
          entity: 'task',
          entityId: null,
          actor: meta?.actor ?? 'user',
          after: { count: normalized.length, project: project ?? null },
        })
        return draft
      }, { intent: 'task.reorder' })
      return { reordered: normalized.length }
    },

    /**
     * **归档 / 恢复（WP5）**。
     *
     * 归档与软删是**两件不同的事**：归档是「做完了、收起来」，不是「删掉」。
     * 用独立字段 `archived` 表达，因此：
     *   - 归档的待办仍在库里、仍可被 AI 读到（`task.list` 默认含归档，除非 archived:false）
     *   - 软删（deleted）才需要审批；归档**不需要**（它不是破坏性操作）
     *   - 恢复归档也不改变任何其它字段
     *
     * `archived` 与 `deleted` 同时为真时以 `deleted` 为准（不可见），
     * 避免「归档后删掉、恢复归档时又冒出来」的语义混乱。
     */
    'task.archive': (payload, meta) => {
      const ids = payload?.ids ?? (payload?.id === undefined ? undefined : [payload.id])
      if (!Array.isArray(ids) || ids.length === 0) {
        throw validationError('id 或 ids 必须提供')
      }
      const normalized = [...new Set(ids.map(String))]
      const archived = payload?.archived !== false
      const rows = store.collection('tasks')
      const missing = normalized.filter((id) => !rows.some((row) => row.id === id))
      if (missing.length > 0) {
        throw notFoundError('存在未知的待办 id', { missing })
      }
      store.mutate((draft) => {
        for (const row of draft.tasks) {
          if (!normalized.includes(row.id)) continue
          if (archived) row.archived = true
          else delete row.archived
        }
        draft.audit.push({
          id: (options.idFactory ?? (() => randomUUID()))(),
          at: now().toISOString(),
          action: archived ? 'task.archive' : 'task.unarchive',
          entity: 'task',
          entityId: normalized.length === 1 ? normalized[0] : null,
          actor: meta?.actor ?? 'user',
          after: { count: normalized.length, archived },
        })
        return draft
      }, { intent: archived ? 'task.archive' : 'task.unarchive' })
      const result = store.collection('tasks').filter((row) => normalized.includes(row.id))
      return { archived, tasks: result }
    },
  }

  return {
    /**
     * **只读投影**，不含任何写方法。
     *
     * 第二轮 Review 的 N1' 指认：原先直接返回 `store` / `events`，于是
     * `svc.events.remove(id)`、`svc.store.replace()`、`svc.store.rollback()`
     * 都能**绕过审批**直接改数据——把审批门开在一扇装了锁的门旁边。
     *
     * 现在只暴露两个只读查询；所有写路径必须走 `execute()`，由它做审批校验。
     * 也**有意不暴露 gate 对象**（拿到它就能自签 token）。
     */
    store: Object.freeze({
      listBackups: () => store.listBackups(),
      listPreBackups: () => store.listPreBackups(),
    }),
    events: Object.freeze({
      list: () => events.list(),
      get: (id) => events.get(id),
    }),
    requestApproval,
    /**
     * 用户在 UI 里显式确认后，由**宿主**签发一次性凭证。
     *
     * 用途：DSH 的 `ctx.approval.request` 只能在模型回合内发起
     * （dsh-user-approval/README.md:153），而 UI 的删除是回合外的用户操作，
     * 走 DSH 审批必然失败（WP4 第四轮 Review 的 BLOCKER-4）。
     *
     * 凭证由 gate 签发（绑定 op+target+digest、一次性、不可离线伪造），
     * 因此仍满足「不认 payload 里的 confirmed 布尔」这条硬约束。
     */
    confirmUserAction: (op, target, detail = {}) => {
      /**
       * 只允许**破坏性**操作走「用户确认」凭证。
       *
       * 若允许任意 op 签发，等于给了一个万能钥匙（任何 commands 调用方都能
       * 换一个 snapshot.replace 的凭证）。这里限定在 DANGEROUS_OPS 内，
       * 且仍受一次性 + 指纹绑定约束。
       */
      if (!DANGEROUS_OPS.includes(op)) {
        throw validationError(`操作不在可确认清单内：${op}`, { op })
      }
      return gate.issueForUserConfirm(op, target, detail)
    },
    defaultTimeZone,
    /**
     * 唯一入口。
     * @param {string} op
     * @param {unknown} payload
     * @param {{ actor?: string, confirmed?: boolean }} [meta]
     */
    execute(op, payload, meta = {}) {
      const handler = ops[op]
      if (handler === undefined) {
        throw unsupportedError(`不支持的操作：${op}`, { op, supported: Object.keys(ops).sort() })
      }
      /**
       * **N-05**：`deny` 模式的拦截必须放在**唯一入口**。
       *
       * 放在各 handler 的 `requireConfirmation` 里会漏——`store.backup` 不在
       * 危险清单，于是 deny 下照样备份；实测就是这么漏的。
       * 在 `execute` 统一拦住，才能覆盖全部写操作，且将来新增 handler 自动受控。
       */
      if (gate.mode === 'deny' && WRITE_OPS.includes(op)) {
        throw confirmationRequired(`不可写模式（deny）：${op} 一律拒绝`, {
          op, reason: 'approval-mode-deny',
        })
      }
      return handler(payload, meta)
    },
    listOps() {
      return Object.keys(ops).sort()
    },
  }
}

/** 待办是否已被软删（deleted 标记或 deletedAt 时间戳）。 */
function isTaskDeleted(task) {
  if (task === null || typeof task !== 'object') return false
  if (task.deleted === true) return true
  return typeof task.deletedAt === 'string' && task.deletedAt !== ''
}

function requireId(payload, field) {
  const value = payload?.[field]
  if (typeof value !== 'string' || value === '') {
    throw validationError(`${field} 必须是非空字符串`, { field, got: typeof value })
  }
  return value
}

function requireString(payload, field) {
  const value = payload?.[field]
  if (typeof value !== 'string' || value === '') {
    throw validationError(`${field} 必须是非空字符串`, { field, got: typeof value })
  }
  return value
}

function requireNumber(payload, field) {
  const value = payload?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(`${field} 必须是有限数字`, { field, got: typeof value })
  }
  return value
}


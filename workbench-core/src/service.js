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
import { AUDIT_ACTIONS, createEventRepo } from './event-repo.js'
import { expandEvents } from './recurrence.js'
import { buildIcs, exportJson, parseIcs, parseJsonSnapshot } from './ics.js'
import { approvalFingerprint, createHostApprovalGate } from './approval-gate.js'
import { openStore } from './store.js'
import { validateEventInput } from './event.js'

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
])

/**
 * 创建服务。
 * @param {{ dataDir: string, now?: () => Date, idFactory?: () => string }} options
 */
export function createWorkbenchService(options) {
  const store = openStore(options.dataDir, { now: options.now })
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

    'event.delete': (payload, meta) => {
      const id = requireId(payload, 'id')
      requireConfirmation('event.delete', meta, { target: id })
      return events.remove(id, { actor: meta?.actor })
    },

    'event.restore': (payload, meta) => {
      const id = requireId(payload, 'id')
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
    'event.previewIcs': (payload) => {
      const text = requireString(payload, 'text')
      const parsed = parseIcs(text, { defaultTimeZone: payload.defaultTimeZone })
      const existing = events.listActive()
      const plan = parsed.events.map((incoming) => {
        const sameUid = existing.find((row) => (row.uid ?? row.id) === (incoming.uid ?? incoming.id))
        return {
          action: sameUid === undefined ? 'create' : 'skip-duplicate-uid',
          uid: incoming.uid ?? null,
          title: incoming.title,
          allDay: incoming.allDay === true,
          startDate: incoming.startDate ?? null,
          start: incoming.start ?? null,
          timeZone: incoming.timeZone ?? null,
        }
      })
      return {
        plan,
        counts: {
          create: plan.filter((x) => x.action === 'create').length,
          skip: plan.filter((x) => x.action !== 'create').length,
        },
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

    'snapshot.preview': (payload) => {
      const text = requireString(payload, 'text')
      const parsed = parseJsonSnapshot(text)
      const currentIds = new Set(events.list().map((row) => row.id))
      return {
        events: parsed.events.length,
        tasks: parsed.tasks.length,
        newEvents: parsed.events.filter((row) => !currentIds.has(row.id)).length,
        warnings: parsed.warnings,
      }
    },

    'snapshot.replace': (payload, meta) => {
      const text = requireString(payload, 'text')
      requireConfirmation('snapshot.replace', meta, { digest: contentDigest(text) })
      const parsed = parseJsonSnapshot(text)
      const backup = store.backup('before-snapshot-replace')
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
      return { replaced: { events: parsed.events.length, tasks: parsed.tasks.length }, backup }
    },

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
      /**
       * **条件审批**（复审 MAJOR 修复）：
       *
       * 复审发现软删绕过审批门（`task.upsert` 从不调 requireConfirmation，
       * token 可伪造）。但不能一律审批——新建待办是正常路径（授权要求
       * 「快速创建」「创建和完成待办」顺畅），一律要审批会把体验打崩。
       *
       * 语义对齐 Event 侧（`event.create` 不在危险清单，`event.update` 需要）：
       *   - **新建**待办 → 不需要审批
       *   - **编辑/完成**既有待办 → 不需要审批（授权要求「创建和完成待办」顺畅）
       *   - **软删**待办（deleted/deletedAt）→ 需要审批（破坏性）
       *
       * 指纹用 task.id，凭证仍只能由宿主签发。
       */
      const isSoftDelete = task.deleted === true
        || (typeof task.deletedAt === 'string' && task.deletedAt !== '')
      if (isSoftDelete) {
        requireConfirmation('task.upsert', meta, { target: task.id })
      }
      store.mutate((draft) => {
        const index = draft.tasks.findIndex((row) => row.id === task.id)
        if (index < 0) draft.tasks.push({ ...task })
        else draft.tasks[index] = { ...task }
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
      return { task: structuredClone(task) }
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


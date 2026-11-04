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
    return gate.request({
      op,
      target: detail.target,
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
      requireConfirmation('event.bulkDelete', meta, { target: [...ids].map(String).sort().join(',') })
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
       * 指纹绑定**具体备份名**（N4）：只写 'latest' 会 TOCTOU——
       * 审批之后又产生新备份，实际回滚目标就前移了。
       */
      const backups = store.listPreBackups()
      if (backups.length === 0) {
        throw notFoundError('没有可用备份')
      }
      const targetName = payload?.name ?? backups[backups.length - 1]
      if (!backups.includes(targetName)) {
        throw notFoundError(`备份不存在：${targetName}`, { targetName })
      }
      requireConfirmation('store.rollback', meta, { target: targetName })
      return store.rollback(targetName)
    },
    'store.audit': (payload = {}) => events.auditLog({ entityId: payload.entityId }),

    // ---- Task 门面（不改既有数据，只做统一入口） ---------------------------
    'task.list': () => store.collection('tasks'),
    'task.upsert': (payload, meta) => {
      const task = payload?.task
      if (task === null || typeof task !== 'object' || Array.isArray(task)) {
        throw validationError('task 必须是对象')
      }
      if (typeof task.id !== 'string' || task.id === '') {
        throw validationError('task.id 必须是非空字符串')
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
    store,
    events,
    /**
     * 有意**不暴露 gate 对象**：拿到它就能自己 request() 自签 token，
     * 审批等于形同虚设（独立 Review 的 N1）。调用方只用 requestApproval()。
     */
    requestApproval,
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
      return handler(payload, meta)
    },
    listOps() {
      return Object.keys(ops).sort()
    },
  }
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


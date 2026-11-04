/**
 * Event 仓库：在 store 之上提供实体级 CRUD。
 *
 * 约定：
 * - 所有写入都经 `store.mutate`（原子 + 备份 + 中断回滚）。
 * - 每次写都追加一条审计记录（谁、做了什么、前后关键字段），供"操作历史"用。
 * - id 由调用方注入（默认 randomUUID），便于测试确定性与导入保 id。
 */

import { randomUUID } from 'node:crypto'

import { conflictError, notFoundError } from './errors.js'
import { normalizeEventInput, validateEventInput } from './event.js'
import { isoInstant } from './validate.js'

/** 审计动作名。 */
export const AUDIT_ACTIONS = Object.freeze({
  CREATE: 'event.create',
  UPDATE: 'event.update',
  DELETE: 'event.delete',
  RESTORE: 'event.restore',
  IMPORT: 'event.import',
  ROLLBACK: 'store.rollback',
})

const MAX_AUDIT = 5000

/**
 * @param {ReturnType<import('./store.js').openStore>} store
 * @param {{ now?: () => Date, idFactory?: () => string }} [options]
 */
export function createEventRepo(store, options = {}) {
  const now = options.now ?? (() => new Date())
  const idFactory = options.idFactory ?? (() => randomUUID())
  const stamp = () => isoInstant(now().toISOString(), 'now')

  const pushAudit = (draft, entry) => {
    draft.audit.push({ id: idFactory(), at: stamp(), ...entry })
    if (draft.audit.length > MAX_AUDIT) {
      draft.audit.splice(0, draft.audit.length - MAX_AUDIT)
    }
  }

  return {
    /** 列出全部事件（含已取消；调用方自行过滤）。 */
    list() {
      return store.collection('events')
    },

    /** 按 id 取；不存在抛 not-found。 */
    get(id) {
      const found = store.read().events.find((event) => event.id === id)
      if (found === undefined) throw notFoundError(`事件不存在：${id}`, { id })
      return structuredClone(found)
    },

    find(id) {
      const found = store.read().events.find((event) => event.id === id)
      return found === undefined ? undefined : structuredClone(found)
    },

    /**
     * 创建事件。
     * @param {unknown} input 原始输入（会被校验）
     * @param {{ actor?: string, id?: string }} [meta]
     */
    create(input, meta = {}) {
      const validated = validateEventInput(input)
      const normalized = normalizeEventInput(validated)
      const id = meta.id ?? idFactory()
      const at = stamp()
      const row = {
        id,
        uid: normalized.uid ?? id,
        ...normalized,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      }
      delete row.uid_duplicate
      store.mutate(
        (draft) => {
          if (draft.events.some((event) => event.id === id)) {
            throw conflictError(`事件 id 已存在：${id}`, { id })
          }
          draft.events.push(row)
          pushAudit(draft, { action: AUDIT_ACTIONS.CREATE, entity: 'event', entityId: id, actor: meta.actor ?? 'user', after: summarize(row) })
          return draft
        },
        { intent: 'event.create' },
      )
      return structuredClone(row)
    },

    /**
     * 部分更新：只允许改白名单字段，未提供的保持原值。
     * 时间字段改动会重新走完整校验（避免把 start 改早于 end）。
     */
    update(id, patch, meta = {}) {
      const current = this.get(id)
      const merged = mergePatch(current, patch)
      const validated = validateEventInput(merged)
      const normalized = normalizeEventInput(validated)
      const at = stamp()
      const next = {
        ...current,
        ...normalized,
        uid: current.uid,
        updatedAt: at,
      }
      store.mutate(
        (draft) => {
          const index = draft.events.findIndex((event) => event.id === id)
          if (index < 0) throw notFoundError(`事件不存在：${id}`, { id })
          draft.events[index] = next
          pushAudit(draft, {
            action: AUDIT_ACTIONS.UPDATE,
            entity: 'event',
            entityId: id,
            actor: meta.actor ?? 'user',
            before: summarize(current),
            after: summarize(next),
          })
          return draft
        },
        { intent: 'event.update' },
      )
      return structuredClone(next)
    },

    /** 软删除（保留可恢复）。 */
    remove(id, meta = {}) {
      const current = this.get(id)
      const at = stamp()
      store.mutate(
        (draft) => {
          const index = draft.events.findIndex((event) => event.id === id)
          if (index < 0) throw notFoundError(`事件不存在：${id}`, { id })
          draft.events[index] = { ...current, deletedAt: at, updatedAt: at }
          pushAudit(draft, { action: AUDIT_ACTIONS.DELETE, entity: 'event', entityId: id, actor: meta.actor ?? 'user', before: summarize(current) })
          return draft
        },
        { intent: 'event.delete' },
      )
      return { id, deletedAt: at }
    },

    /** 恢复软删除。 */
    restore(id, meta = {}) {
      const current = this.get(id)
      if (current.deletedAt === null) {
        throw conflictError(`事件未被删除，无需恢复：${id}`, { id })
      }
      const at = stamp()
      const next = { ...current, deletedAt: null, updatedAt: at }
      store.mutate(
        (draft) => {
          const index = draft.events.findIndex((event) => event.id === id)
          if (index < 0) throw notFoundError(`事件不存在：${id}`, { id })
          draft.events[index] = next
          pushAudit(draft, { action: AUDIT_ACTIONS.RESTORE, entity: 'event', entityId: id, actor: meta.actor ?? 'user' })
          return draft
        },
        { intent: 'event.restore' },
      )
      return structuredClone(next)
    },

    /** 只返回未删除的活跃事件。 */
    listActive() {
      return store.collection('events').filter((event) => event.deletedAt === null)
    },

    /** 审计记录（可按实体过滤）。 */
    auditLog({ entityId } = {}) {
      const rows = store.collection('audit')
      return entityId === undefined ? rows : rows.filter((row) => row.entityId === entityId)
    },
  }
}

/** 只允许这些字段被 patch 覆盖，其余忽略（防越权改 id/createdAt）。 */
const PATCHABLE = [
  'title', 'description', 'location', 'allDay',
  'startDate', 'endDate', 'start', 'end', 'timeZone',
  'recurrence', 'importance', 'tags', 'source', 'status',
]

function mergePatch(current, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw conflictError('patch 必须是对象', { got: typeof patch })
  }
  const merged = {
    title: current.title,
    description: current.description,
    location: current.location,
    allDay: current.allDay,
    startDate: current.startDate ?? undefined,
    endDate: current.endDate ?? undefined,
    start: current.start ?? undefined,
    end: current.end ?? undefined,
    timeZone: current.timeZone ?? undefined,
    recurrence: current.recurrence ?? undefined,
    importance: current.importance,
    tags: current.tags,
    source: current.source,
  }
  for (const key of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      merged[key] = patch[key]
    }
  }
  // 显式清空：null 表示"置空"（endDate/end/recurrence）
  for (const key of ['endDate', 'end', 'recurrence']) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === null) {
      merged[key] = undefined
    }
  }
  // 时间表达切换：从全天转定时或反之，需清掉另一组字段
  if (merged.allDay) {
    delete merged.start
    delete merged.end
    delete merged.timeZone
  } else {
    delete merged.startDate
    delete merged.endDate
  }
  return merged
}

function summarize(row) {
  return {
    title: row.title,
    allDay: row.allDay,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    start: row.start ?? null,
    end: row.end ?? null,
    timeZone: row.timeZone ?? null,
    recurrence: row.recurrence ?? null,
    importance: row.importance,
  }
}

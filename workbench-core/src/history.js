/**
 * 操作级撤销 / 重做（WP5）。
 *
 * ## 为什么不用 store.backup / rollback
 *
 * 那套是**灾难恢复**：按文件序号回滚到「某次提交之前」，粒度是整库、语义是
 * 「文件坏了才用」。用户按 Cmd+Z 要的是**操作级**撤销：只撤最后一次改动，
 * 而且能重做回来。
 *
 * ## 存什么
 *
 * 撤销栈里存的是**被改动集合的前一份内容**（`events` + `tasks`），不是整库：
 * - 只回写这两个集合，审计日志（`audit`）保持追加语义，不因撤销而消失
 * - 回写用 set-by-id，不是整体替换 —— 撤销「改 A」不能把同时新建的 B 一起弄没
 *
 * ## 一致性
 *
 * 撤销与重做本身也是 `store.mutate`，因此：
 * - 原子写 + journal 崩溃恢复对它们同样成立
 * - 每次撤销/重做都落审计（`history.undo` / `history.redo`），可追溯
 * - 栈随存储快照一起持久化，重启后仍在
 *
 * ## 边界（明确不做的）
 *
 * - 栈深度上限 20（超出丢最旧）。没有上限的栈在长会话里会无限膨胀。
 * - 撤销**不**跨进程合并：单进程假设（与 store 的整体假设一致）。
 * - 撤销不恢复 `audit`，所以撤销「撤销」这件事本身会留下两条记录 —— 这是刻意的：
 *   审计是流水，不是状态。
 */

import { randomUUID } from 'node:crypto'

import { notFoundError, validationError } from './errors.js'
import { DEFAULT_HISTORY_LIMIT, UNDOABLE_KEYS } from './store.js'

/** 参与撤销的集合：只有业务数据，不含审计。 */
const UNDOABLE_COLLECTIONS = UNDOABLE_KEYS

const pick = (snapshot) => {
  const out = {}
  for (const key of UNDOABLE_COLLECTIONS) out[key] = snapshot[key] ?? []
  return out
}

const cloneEntry = (entry) => JSON.parse(JSON.stringify(entry))

/**
 * @param {object} store openStore 的实例
 * @param {{ now?: () => Date, limit?: number, idFactory?: () => string }} [options]
 */
export function createHistoryOps(store, options = {}) {
  const now = options.now ?? (() => new Date())
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT
  const idFactory = options.idFactory ?? (() => randomUUID())

  const readStack = (name) => {
    const rows = store.read()[name]
    return Array.isArray(rows) ? rows : []
  }

  return {
    'history.status': () => {
      const undoStack = readStack('undo')
      const redoStack = readStack('redo')
      return {
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        // 只暴露标签，不把整份快照吐给 UI（那可能是几十 KB）
        nextUndo: undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null,
        nextRedo: redoStack.length > 0 ? redoStack[redoStack.length - 1].label : null,
      }
    },

    'history.undo': (_payload, meta) => {
      const undoStack = readStack('undo')
      if (undoStack.length === 0) {
        throw notFoundError('没有可撤销的操作')
      }
      const entry = undoStack[undoStack.length - 1]
      const current = pick(store.read())
      const result = store.mutate((draft) => {
        // 只回写被改动的集合；audit 保持追加
        for (const key of UNDOABLE_COLLECTIONS) draft[key] = cloneEntry(entry.before[key])
        const remaining = Array.isArray(draft.undo) ? draft.undo : []
        remaining.pop()
        draft.undo = remaining
        const redoStack = Array.isArray(draft.redo) ? draft.redo : []
        redoStack.push({ id: idFactory(), label: entry.label, at: now().toISOString(), before: cloneEntry(current) })
        draft.redo = redoStack.slice(Math.max(0, redoStack.length - limit))
        draft.audit.push({
          id: idFactory(),
          at: now().toISOString(),
          action: 'history.undo',
          entity: 'store',
          entityId: entry.id ?? null,
          actor: meta?.actor ?? 'user',
          after: { label: entry.label },
        })
        return draft
      }, { intent: 'history.undo', undo: false })
      return { undone: { label: entry.label, at: entry.at }, ...pick(result) }
    },

    'history.redo': (_payload, meta) => {
      const redoStack = readStack('redo')
      if (redoStack.length === 0) {
        throw notFoundError('没有可重做的操作')
      }
      const entry = redoStack[redoStack.length - 1]
      const current = pick(store.read())
      const result = store.mutate((draft) => {
        for (const key of UNDOABLE_COLLECTIONS) draft[key] = cloneEntry(entry.before[key])
        const remaining = Array.isArray(draft.redo) ? draft.redo : []
        remaining.pop()
        draft.redo = remaining
        const undoStack = Array.isArray(draft.undo) ? draft.undo : []
        undoStack.push({ id: idFactory(), label: entry.label, at: now().toISOString(), before: cloneEntry(current) })
        draft.undo = undoStack.slice(Math.max(0, undoStack.length - limit))
        draft.audit.push({
          id: idFactory(),
          at: now().toISOString(),
          action: 'history.redo',
          entity: 'store',
          entityId: entry.id ?? null,
          actor: meta?.actor ?? 'user',
          after: { label: entry.label },
        })
        return draft
      }, { intent: 'history.redo', undo: false })
      return { redone: { label: entry.label, at: entry.at }, ...pick(result) }
    },
  }
}

/**
 * 校验撤销栈长度上限参数（供调用方在启动时校验）。
 * @param {unknown} value
 */
export function assertHistoryLimit(value) {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw validationError('historyLimit 必须是 1..200 的整数', { got: value })
  }
  return value
}

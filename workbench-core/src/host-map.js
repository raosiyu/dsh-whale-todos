/**
 * 宿主映射表：`reminderKey ↔ hostId ↔ sessionId` 的**持久化**存储。
 *
 * ## 为什么必须持久化
 *
 * 真实宿主的 `list()` **不回报业务 key**（见 `docs/wp2/05-host-contract.md` §三），
 * 而进程重启后内存映射全丢。若不落盘，重启后只能靠 `title + scheduledAt` 猜身份——
 * 而「同标题同刻的两条不同提醒」会撞成同一个身份，导致：
 * - 取消一条，另一条成孤儿仍会响；
 * - `reconcile` 把合法提醒判为多余删除。
 *
 * 所以身份只能来自**本地持久化映射**：写入时记 `reminderKey → hostId`，
 * 重启后读回，绝不猜。
 *
 * ## 原子性
 *
 * 与 `store.js` 同一套手法：临时文件 + fsync + rename，避免半截文件。
 * 映射损坏时不静默重建（那会导致身份漂移），而是抛出可判定错误。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { storeCorruptError, validationError } from './errors.js'

const SCHEMA_VERSION = 1

/**
 * 本地映射的保留上限。
 *
 * 为什么需要：修 B2 时保留了 `inactive`（已投递）记录以免丢投递历史，
 * 但保留没上限 → 长期运行后 `hostmap.json` 与 `catalog()` 扫描成本线性增长
 * （自查实测：30 条即 4.8 KB，且宿主侧同样累积）。
 *
 * 策略：按 `fireAtMs` 保留最近 `maxEntries` 条，且**只删本地映射**——
 * 宿主记录由宿主自己的 retention 管理，删它等于丢掉投递回执。
 */
const DEFAULT_MAX_ENTRIES = 500

/** 空映射的初始形状。 */
const emptyState = () => ({ version: SCHEMA_VERSION, entries: {} })

/**
 * @param {{ filePath: string }} options
 */
export function openHostMap(options) {
  const filePath = options.filePath
  if (typeof filePath !== 'string' || filePath === '') {
    throw validationError('hostMap 需要 filePath')
  }
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES

  /** @type {{ version: number, entries: Record<string, {hostId: string, sessionId: string, fireAtMs: number, title: string, kind: string}> }} */
  let state = emptyState()

  const load = () => {
    if (!existsSync(filePath)) {
      state = emptyState()
      return
    }
    let raw
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      throw storeCorruptError(`宿主映射读取失败：${String(error?.message ?? error)}`, { filePath })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw storeCorruptError(`宿主映射不是合法 JSON：${String(error?.message ?? error)}`, { filePath })
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw storeCorruptError('宿主映射根必须是对象', { filePath })
    }
    if (parsed.version !== SCHEMA_VERSION) {
      throw storeCorruptError(`宿主映射版本不支持：${String(parsed.version)}`, {
        filePath, expected: SCHEMA_VERSION, got: parsed.version,
      })
    }
    const entries = parsed.entries
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
      throw storeCorruptError('宿主映射 entries 必须是对象', { filePath })
    }
    for (const [key, value] of Object.entries(entries)) {
      if (value === null || typeof value !== 'object') {
        throw storeCorruptError(`宿主映射条目非法：${key}`, { filePath, key })
      }
      if (typeof value.hostId !== 'string' || value.hostId === '') {
        throw storeCorruptError(`宿主映射条目缺 hostId：${key}`, { filePath, key })
      }
      if (typeof value.sessionId !== 'string' || value.sessionId === '') {
        throw storeCorruptError(`宿主映射条目缺 sessionId：${key}`, { filePath, key })
      }
    }
    state = { version: SCHEMA_VERSION, entries: { ...entries } }
  }

  const persist = () => {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.hostmap.tmp`)
    const body = JSON.stringify(state, null, 2)
    writeFileSync(tmp, body, 'utf8')
    // fsync 后 rename：避免掉电留下半截文件
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, filePath)
  }

  /**
   * 按 `fireAtMs` 保留最近 maxEntries 条；只动本地映射。
   * @returns {string[]} 被裁掉的 reminderKey
   */
  const prune = () => {
    const all = Object.entries(state.entries)
    if (all.length <= maxEntries) return []
    // 未来时刻优先保留，其次按时间倒序
    const ordered = all.sort((a, b) => {
      const fa = Number.isFinite(a[1].fireAtMs) ? a[1].fireAtMs : 0
      const fb = Number.isFinite(b[1].fireAtMs) ? b[1].fireAtMs : 0
      return fb - fa
    })
    const drop = ordered.slice(maxEntries).map(([k]) => k)
    for (const k of drop) delete state.entries[k]
    return drop
  }

  load()

  return {
    /** 重新从磁盘读取（模拟进程重启）。 */
    reload: load,

    /** 按 reminderKey 取映射。 */
    get(reminderKey) {
      const found = state.entries[reminderKey]
      return found === undefined ? undefined : { ...found }
    },

    /** 列出全部映射（副本）。 */
    entries() {
      return Object.entries(state.entries).map(([reminderKey, value]) => ({ reminderKey, ...value }))
    },

    /** 某 session 下的全部映射。 */
    entriesForSession(sessionId) {
      return this.entries().filter((e) => e.sessionId === sessionId)
    },

    /**
     * 写入/覆盖一条映射。
     * @param {{ reminderKey: string, hostId: string, sessionId: string, fireAtMs: number, title: string, kind: string }} entry
     */
    put(entry) {
      if (typeof entry.reminderKey !== 'string' || entry.reminderKey === '') {
        throw validationError('put 需要 reminderKey')
      }
      if (typeof entry.hostId !== 'string' || entry.hostId === '') {
        throw validationError('put 需要 hostId', { reminderKey: entry.reminderKey })
      }
      if (typeof entry.sessionId !== 'string' || entry.sessionId === '') {
        throw validationError('put 需要 sessionId', { reminderKey: entry.reminderKey })
      }
      // hostId 必须全局唯一：两个 reminderKey 指向同一个 hostId 说明身份出错
      for (const [key, value] of Object.entries(state.entries)) {
        if (key !== entry.reminderKey && value.hostId === entry.hostId) {
          throw validationError('hostId 已被其它 reminderKey 占用', {
            reminderKey: entry.reminderKey, conflicting: key, hostId: entry.hostId,
          })
        }
      }
      state.entries[entry.reminderKey] = {
        hostId: entry.hostId,
        sessionId: entry.sessionId,
        fireAtMs: entry.fireAtMs,
        title: entry.title,
        kind: entry.kind,
        /**
         * **scope 是一等字段**（第三轮 Review 的 M3'/N-11）。
         *
         * 旧实现用 `reminderKey.startsWith('<scope>:')` 判断归属，但真实 key 是
         * 裸 sha256（如 `9e053361…`），永远不可能带前缀 → 隔离实质失效。
         * 改为把 scope 存成映射字段，按字段比较。
         */
        scope: typeof entry.scope === 'string' ? entry.scope : '',
      }
      prune()
      persist()
      return { ...state.entries[entry.reminderKey] }
    },

    /** 删除一条映射；不存在返回 false。 */
    remove(reminderKey) {
      if (state.entries[reminderKey] === undefined) return false
      delete state.entries[reminderKey]
      persist()
      return true
    },

    /** 删除某 hostId 的映射（宿主侧记录消失时清理）。 */
    removeByHostId(hostId) {
      for (const [key, value] of Object.entries(state.entries)) {
        if (value.hostId === hostId) {
          delete state.entries[key]
          persist()
          return key
        }
      }
      return undefined
    },

    /** 手动裁剪映射（只删本地，不碰宿主）。返回被裁掉的 key。 */
    prune() {
      const dropped = prune()
      if (dropped.length > 0) persist()
      return dropped
    },

    /** 当前保留上限。 */
    get maxEntries() {
      return maxEntries
    },

    /** 清空（测试用）。 */
    clear() {
      state = emptyState()
      persist()
    },

    get size() {
      return Object.keys(state.entries).length
    },
  }
}

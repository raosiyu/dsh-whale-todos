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

/**
 * 身份索引的**时间**保留窗口（默认 180 天）。
 *
 * 只丢弃「早已投递、宿主侧已转 inactive」的身份；近期身份一律保留，
 * 以免重复投递。窗口内的时间抖动不影响：判据是提醒的触发时刻，
 * 不是写入时刻。
 */
const DEFAULT_INDEX_RETENTION_MS = 180 * 24 * 60 * 60 * 1000

/** 空映射的初始形状。 */
const emptyState = () => ({ version: SCHEMA_VERSION, entries: {}, index: {}, indexScopes: {} })

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
  const indexRetentionMs = Number.isSafeInteger(options.indexRetentionMs) && options.indexRetentionMs > 0
    ? options.indexRetentionMs
    : DEFAULT_INDEX_RETENTION_MS
  const now = options.now ?? (() => Date.now())

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
    // index 是 hostId → reminderKey 的身份索引（可选，兼容旧文件）
    const index = parsed.index === null || parsed.index === undefined ? {} : parsed.index
    if (index === null || typeof index !== 'object' || Array.isArray(index)) {
      throw storeCorruptError('宿主映射 index 必须是对象', { filePath })
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
    const indexScopes = parsed.indexScopes === null || parsed.indexScopes === undefined
      ? {}
      : parsed.indexScopes
    state = {
      version: SCHEMA_VERSION,
      entries: { ...entries },
      index: { ...index },
      indexScopes: { ...indexScopes },
    }
  }

  /**
   * 落盘。**原子**：临时文件 + fsync + rename，避免半截文件。
   *
   * 性能：每次 put 都全量写会让 N 次写入变成 O(N²) 的 I/O
   * （实测 2000 条写入耗时 8.8 秒）。因此改为**脏标记 + 显式 flush**：
   * put 只改内存并置脏，flush 时才落盘。
   *
   * 崩溃安全由调用方保证：关键节点（reconcile 结束、进程退出）必须 flush；
   * 未 flush 的改动会丢——但**身份索引丢了会导致重复投递**，
   * 所以 flush 的时机由调用方显式决定，不做隐式后台落盘。
   */
  let dirty = false
  const writeNow = () => {
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
    dirty = false
  }
  const persist = () => { dirty = true }

  /**
   * 按 `fireAtMs` 保留最近 maxEntries 条；只动本地映射。
   * @returns {string[]} 被裁掉的 reminderKey
   */
  /**
   * 裁剪策略（修正 R5 探针发现的重复创建缺陷）。
   *
   * 原实现把超出上限的条目**整条删除**。后果：
   * 这些 key 从本地映射消失 → `catalog()` 不认领宿主上对应的行 →
   * 它们变成 unmapped → 下次 reconcile 认为「宿主没有这条」→ **再建一份**。
   * 实测 600 条、maxEntries=500 时宿主侧涨到 700 条。
   *
   * 修正：**不丢身份**。超出上限的条目压缩成「墓碑」——
   * 只留 `hostId`（用于在宿主侧认出这条）与 `fireAtMs`（用于排序），
   * 丢弃 title/prompt/scope 等非必要字段。
   * 墓碑仍能回答「宿主上这条 id 对应哪个 reminderKey」，因此不会重复创建；
   * 同时体积大幅下降（标题往往比 id 长得多）。
   */
  const prune = () => {
    /**
     * **时间老化（无条件执行）**。
     *
     * 放在条数裁剪之前：条数裁剪只在超限时才跑，而老化必须**每次**都跑，
     * 否则索引永不收敛。
     */
    /**
     * 时间老化：**只**丢弃「触发时刻早于保留窗口」的身份。
     *
     * 保守性说明：判据用 `fireAtMs`（提醒的触发时刻，绝对时间戳）。
     * 若时钟异常导致 fireAtMs 落在窗口外，身份会被丢 → 可能重复投递。
     * 因此窗口取 180 天（远大于任何合理时钟偏差），且**条目**与索引一起删
     * ——只删索引的话回退路径仍会命中，身份等于没丢（实测 drop=true 仍能反查到）。
     *
     * 已知取舍：老条目被删后，若它仍在 desired 里会被重建。
     * 但那类提醒的触发时刻早已过去，`compileReminder` 会把它滤掉，
     * 正常路径不会进 desired。
     */
    const cutoff = now() - indexRetentionMs
    for (const [hostId, key] of Object.entries(state.index)) {
      const fireAt = state.entries[key]?.fireAtMs
      // 条目已被条数裁剪掉时没有 fireAtMs 可依据 → 保守保留（不冒重复投递的风险）
      if (fireAt === undefined) continue
      if (fireAt < cutoff) {
        delete state.index[hostId]
        delete state.entries[key]
      }
    }

    const all = Object.entries(state.entries)
    if (all.length <= maxEntries) return []
    // 未来时刻优先保留，其次按时间倒序
    const ordered = all.sort((a, b) => {
      const fa = Number.isFinite(a[1].fireAtMs) ? a[1].fireAtMs : 0
      const fb = Number.isFinite(b[1].fireAtMs) ? b[1].fireAtMs : 0
      return fb - fa
    })
    const drop = ordered.slice(maxEntries)
    for (const [k, v] of drop) {
      // 关键：**条目**移出 entries（条目数因此受 maxEntries 限制），
      // 但**身份**（hostId ↔ reminderKey）留在 index 里，体积很小。
      // 这样裁剪既控制住了体积与条目数，又不会因「认不出宿主上的行」而重复创建。
      // 身份索引保留 hostId → reminderKey；scope 由 put 时写入的
      // indexScopes 维护（这里不重复写：条目被裁时 scope 已经在索引里）。
      state.index[v.hostId] = k
      delete state.entries[k]
    }
    return drop.map(([k]) => k)
  }

  load()

  return {
    /** 是否有未落盘的改动。 */
    get dirty() {
      return dirty
    },

    /** 立即落盘（原子）。关键节点必须调用。 */
    flush() {
      if (dirty) writeNow()
      return { flushed: dirty }
    },

    /** 重新从磁盘读取（模拟进程重启）。 */
    reload: load,

    /**
     * 批量建立 hostId → reminderKey 的查找表。
     *
     * **性能要点**：`catalog()` 要对宿主侧每一行做一次身份反查。若每次都调
     * `reminderKeyByHostId`（其回退路径要遍历 entries），整体就是 O(宿主行 × 映射条目)。
     * 实测 2000 条时对账耗时不可接受。改为**一次性建表**后是 O(1) 查表。
     */
    hostIdLookup() {
      const table = new Map()
      for (const [hostId, key] of Object.entries(state.index)) table.set(hostId, key)
      for (const [key, value] of Object.entries(state.entries)) {
        if (!table.has(value.hostId)) table.set(value.hostId, key)
      }
      return table
    },

    /**
     * 按 reminderKey 取 **hostId**。
     *
     * 条目被条数上限裁掉后（成了「墓碑」），完整条目不在 entries 里，
     * 但身份索引仍在 → 仍能拿到 hostId，**否则用户取消的提醒永远删不掉**
     * （复审 B-1：宿主留下幽灵提醒继续响）。
     */
    hostIdOf(reminderKey) {
      const entry = state.entries[reminderKey]
      if (entry !== undefined) return entry.hostId
      for (const [hostId, key] of Object.entries(state.index)) {
        if (key === reminderKey) return hostId
      }
      return undefined
    },

    /**
     * 取映射条目的关键字段（含 scope），条目缺失时回退到身份索引可得的最小信息。
     */
    describe(reminderKey) {
      const entry = state.entries[reminderKey]
      if (entry !== undefined) return { ...entry }
      const hostId = this.hostIdOf(reminderKey)
      if (hostId === undefined) return undefined
      return {
        hostId,
        sessionId: '',
        fireAtMs: 0,
        title: '',
        kind: '',
        scope: state.indexScopes?.[hostId] ?? '',
      }
    },

    /**
     * 按 hostId 反查 reminderKey（单查用；批量请用 hostIdLookup）。
     *
     * 裁剪后完整条目可能已被移除，但身份索引仍在 → 仍能认出宿主上的行，
     * 因此不会重复创建（第三轮探针 P3 发现的缺陷）。
     */
    reminderKeyByHostId(hostId) {
      const direct = state.index[hostId]
      if (direct !== undefined) return direct
      const hit = Object.entries(state.entries).find(([, v]) => v.hostId === hostId)
      return hit === undefined ? undefined : hit[0]
    },

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
      state.index[entry.hostId] = entry.reminderKey
      state.indexScopes = state.indexScopes ?? {}
      state.indexScopes[entry.hostId] = typeof entry.scope === 'string' ? entry.scope : ''
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
      const entry = state.entries[reminderKey]
      if (entry !== undefined) {
        delete state.entries[reminderKey]
        if (state.index[entry.hostId] === reminderKey) delete state.index[entry.hostId]
        if (state.indexScopes?.[entry.hostId] !== undefined) delete state.indexScopes[entry.hostId]
        persist()
        return true
      }
      /**
       * 条目已被裁掉（墓碑）时，身份只剩在 index 里。
       * 只查 entries 会**静默返回 false**，让这条身份永远残留 ——
       * 已删除的提醒仍被认领，可能重复投递。必须一并清掉索引。
       */
      let removed = false
      for (const [hostId, key] of Object.entries(state.index)) {
        if (key !== reminderKey) continue
        delete state.index[hostId]
        if (state.indexScopes?.[hostId] !== undefined) delete state.indexScopes[hostId]
        removed = true
      }
      if (removed) persist()
      return removed
    },

    /** 删除某 hostId 的映射（宿主侧记录消失时清理）。 */
    removeByHostId(hostId) {
      for (const [key, value] of Object.entries(state.entries)) {
        if (value.hostId === hostId) {
          delete state.entries[key]
          if (state.index[hostId] === key) delete state.index[hostId]
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

/**
 * 原子 JSON 存储 + schema 版本 + 备份/回滚 + 审计日志。
 *
 * ## 为什么是文件而不是 SQLite
 *
 * 核心域要在隔离环境**零安装**可跑；且 V1 的写并发极低（单用户、单进程）。
 * 原子性用「同目录临时文件 + fsync + rename」保证：rename 在同一文件系统内是原子的，
 * 读者要么看到旧文件、要么看到新文件，绝不会看到半截。
 *
 * ## 回退模型
 *
 * - 每次写入前把**当前内容**快照到 `backups/`，命名带序号 + 时间戳，保留最近 N 份。
 * - 写入前先写 `journal`（意图），写入成功后清除；启动时若发现残留 journal，
 *   说明上次写入中断 → 自动回滚到最近一份可用备份，并记录 `store-corrupt` 事件。
 * - schema 版本单向递增；遇到更高版本**拒绝启动**（不猜、不降级），避免旧代码写坏新数据。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ERROR_CODES, WorkbenchError } from './errors.js'

export const STORE_SCHEMA_VERSION = 1

/** @typedef {{ version: number, updatedAt: string, events: object[], tasks: object[], audit: object[] }} StoreShape */

/** @returns {StoreShape} */
export const emptyStore = () => ({
  version: STORE_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  events: [],
  tasks: [],
  audit: [],
  undo: [],
  redo: [],
})

const MAX_BACKUPS = 20

/** 参与撤销的集合（只有业务数据，审计是流水不参与）。 */
export const UNDOABLE_KEYS = Object.freeze(['events', 'tasks'])

export const DEFAULT_HISTORY_LIMIT = 20

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * @param {string} dir 数据目录
 * @param {{ now?: () => Date, maxBackups?: number }} [options]
 */
export function openStore(dir, options = {}) {
  const now = options.now ?? (() => new Date())
  const maxBackups = options.maxBackups ?? MAX_BACKUPS
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const file = join(dir, 'workbench.json')
  const backupDir = join(dir, 'backups')
  const journalFile = join(dir, 'workbench.journal')

  const ensureDirs = () => {
    mkdirSync(dir, { recursive: true })
    mkdirSync(backupDir, { recursive: true })
  }

  const writeFileDurable = (target, content) => {
    const tmp = `${target}.tmp-${randomUUID()}`
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  }

  const readJson = (path) => {
    const raw = readFileSync(path, 'utf8')
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new WorkbenchError(ERROR_CODES.STORE_CORRUPT, `存储文件不是合法 JSON：${path}`, {
        path,
        reason: String(error?.message ?? error),
      })
    }
  }

  const validateShape = (data, path) => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new WorkbenchError(ERROR_CODES.STORE_CORRUPT, '存储根节点必须是对象', { path })
    }
    if (!Number.isInteger(data.version)) {
      throw new WorkbenchError(ERROR_CODES.STORE_CORRUPT, '存储缺少整数 version', { path })
    }
    if (data.version > STORE_SCHEMA_VERSION) {
      throw new WorkbenchError(
        ERROR_CODES.SCHEMA_TOO_NEW,
        `存储 schema 版本 ${data.version} 高于本程序支持的 ${STORE_SCHEMA_VERSION}，拒绝启动以免写坏数据`,
        { path, fileVersion: data.version, supported: STORE_SCHEMA_VERSION },
      )
    }
    for (const key of ['events', 'tasks', 'audit']) {
      if (!Array.isArray(data[key])) {
        throw new WorkbenchError(ERROR_CODES.STORE_CORRUPT, `存储字段 ${key} 必须是数组`, { path, field: key })
      }
    }
    // 撤销/重做栈是可选的（老数据没有），但一旦存在就必须是数组
    for (const key of ['undo', 'redo']) {
      if (data[key] !== undefined && !Array.isArray(data[key])) {
        throw new WorkbenchError(ERROR_CODES.STORE_CORRUPT, `存储字段 ${key} 必须是数组`, { path, field: key })
      }
    }
    return data
  }

  const listBackups = () =>
    existsSync(backupDir)
      ? readdirSync(backupDir)
          .filter((name) => /^\d+-(pre|post)-.*\.json$/.test(name))
          .sort()
      : []

  /** 只列「提交前」快照：显式 rollback 的目标（恢复到某次提交之前的状态）。 */
  const listPreBackups = () => listBackups().filter((name) => name.includes('-pre-'))

  const snapshot = (data, kind = 'pre') => {
    ensureDirs()
    const seq = String(listBackups().length + 1).padStart(4, '0')
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const target = join(backupDir, `${seq}-${kind}-${stamp}.json`)
    writeFileDurable(target, JSON.stringify(data, null, 2))
    const all = listBackups()
    for (const stale of all.slice(0, Math.max(0, all.length - maxBackups))) {
      rmSync(join(backupDir, stale), { force: true })
    }
    return target
  }

  const load = () => {
    ensureDirs()
    if (!existsSync(file)) {
      const fresh = emptyStore()
      writeFileDurable(file, JSON.stringify(fresh, null, 2))
      return fresh
    }
    if (existsSync(journalFile)) {
      // 优先用 journal 里携带的 pending 新状态（提交已完整计算、只是没来得及落主文件）
      try {
        const journal = readJson(journalFile)
        if (journal !== null && typeof journal === 'object' && journal.pending !== undefined) {
          const pending = validateShape(journal.pending, journalFile)
          writeFileDurable(file, JSON.stringify(pending, null, 2))
          rmSync(journalFile, { force: true })
          return pending
        }
      } catch {
        // journal 本身损坏：落到备份兜底
      }
      const backups = listBackups()
      if (backups.length > 0) {
        // 备份里最新的一份是「最后一次成功提交」的副本（commit 成功后会追加）
        const latestPath = join(backupDir, backups[backups.length - 1])
        const latest = validateShape(readJson(latestPath), latestPath)
        writeFileDurable(file, JSON.stringify(latest, null, 2))
        rmSync(journalFile, { force: true })
        return latest
      }
      rmSync(journalFile, { force: true })
    }
    return validateShape(readJson(file), file)
  }

  let state = load()

  /**
   * 提交：先把「即将写入的新内容」落到 journal，再原子替换主文件。
   *
   * 崩溃恢复语义（关键）：
   * - 若进程在 journal 写入后、主文件替换前崩溃 → journal 里的内容就是**待生效的新状态**，
   *   恢复时直接用它（等价于这次提交成功），而不是回滚到更旧的备份。
   * - 若 journal 存在但内容不可解析（写入被打断在 journal 本身）→ 回滚到最近一份备份。
   *
   * 早期实现是「先备份旧状态再写」，恢复时只能回到上一次提交，会丢掉一次成功写入；
   * 这里改为「journal 携带新状态」，恢复目标与用户预期一致。
   */
  const commit = (next, meta) => {
    ensureDirs()
    validateShape(next, 'commit')
    const stamped = { ...next, updatedAt: now().toISOString() }
    /**
     * **撤销记录（WP5）挂在 commit 这个唯一拦截点上**，而不是散落在每个业务写方法里。
     *
     * 理由：撤销栈里的「前一份状态」必须和这次写入**原子地**成对出现。
     * 如果各业务方法自己记录，漏一处就是一次不可撤销的改动，
     * 而且并发/异常路径下记的前状态可能是错的。
     * commit 是同步的，`state` 在这里就是**这次写入之前**的权威状态。
     *
     * `meta.undo === false` 用于撤销/重做自身：它们改的就是历史，不能再入栈。
     */
    if (meta?.undo !== false) {
      const before = {}
      for (const key of UNDOABLE_KEYS) before[key] = structuredClone(state[key] ?? [])
      const stack = Array.isArray(stamped.undo) ? stamped.undo.slice() : []
      stack.push({ id: randomUUID(), label: meta?.intent ?? 'write', at: now().toISOString(), before })
      stamped.undo = stack.slice(Math.max(0, stack.length - historyLimit))
      // 新写入让重做栈失效：那段历史已经不在当前状态之上了
      stamped.redo = []
    }
    // 备份旧状态（供显式 rollback）
    snapshot(state, 'pre')
    writeFileDurable(
      journalFile,
      JSON.stringify({ intent: meta?.intent ?? 'write', at: now().toISOString(), target: file, pending: stamped }, null, 2),
    )
    writeFileDurable(file, JSON.stringify(stamped, null, 2))
    rmSync(journalFile, { force: true })
    state = stamped
    // 提交成功后再留一份「已提交」快照：它才是崩溃恢复的权威目标
    snapshot(stamped, 'post')
    return stamped
  }

  return {
    get file() {
      return file
    },
    get dir() {
      return dir
    },
    read() {
      return state
    },
    /** 读取某个集合的副本，避免调用方直接改内部状态。 */
    collection(name) {
      return structuredClone(state[name] ?? [])
    },
    /**
     * 事务式更新：mutator 收到当前快照，返回新快照。
     * @param {(current: StoreShape) => StoreShape} mutator
     * @param {{ intent?: string }} [meta]
     */
    mutate(mutator, meta) {
      const draft = structuredClone(state)
      const next = mutator(draft)
      if (next === undefined || next === null) {
        throw new WorkbenchError(ERROR_CODES.VALIDATION, 'mutator 必须返回新的存储快照')
      }
      return commit(next, meta)
    },
    /** 手动备份（导入/迁移前调用）。 */
    backup(label = 'manual') {
      const target = snapshot(state, 'pre')
      return { path: target, label, at: now().toISOString() }
    },
    listBackups,
    listPreBackups,
    /** 从最近一份（或指定）备份回滚。 */
    rollback(backupName) {
      const backups = listPreBackups()
      if (backups.length === 0) {
        throw new WorkbenchError(ERROR_CODES.NOT_FOUND, '没有可用备份')
      }
      const target = backupName ?? backups[backups.length - 1]
      const path = join(backupDir, target)
      if (!existsSync(path)) {
        throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `备份不存在：${target}`, { target })
      }
      const restored = validateShape(readJson(path), path)
      writeFileDurable(file, JSON.stringify(restored, null, 2))
      state = restored
      /**
       * **回滚必须清空撤销/重做栈**（WP5）。
       *
       * rollback 绕过 commit 直接把 state 换成旧快照，于是栈里那些条目指向的
       * 「前一份状态」已经和当前状态毫无关系了。实测后果：一次失败的批量导入
       * （已建了 3 条，第 4 条炸掉 → rollback）之后按撤销，会把**那 3 条半截数据
       * 重新装回来**——灾难恢复变成了数据复活器。
       *
       * 清空是诚实的做法：回滚之后没有可撤销的历史，因为历史已经被整体替换了。
       */
      if (Array.isArray(state.undo) || Array.isArray(state.redo)) {
        state = { ...state, undo: [], redo: [] }
        writeFileDurable(file, JSON.stringify(state, null, 2))
      }
      return { restored: target, at: now().toISOString() }
    },
    /** 内容指纹（导出/导入校验用）。 */
    fingerprint() {
      return sha256(JSON.stringify({ version: state.version, events: state.events, tasks: state.tasks }))
    },
    /**
     * 把「从 undoDepth 起新增的多条撤销记录」折叠成一条（WP5 导入用）。
     *
     * 批量导入内部会逐条 `create`，于是栈里堆了 N 条 —— 用户要按 N 次 Cmd+Z
     * 才能撤掉一次导入。这里合成一条，`before` 取导入开始前的状态。
     *
     * @param {number} undoDepth 导入开始前的栈深
     * @param {string} label 折叠后的标签
     * @param {object} before 导入开始前的业务集合快照
     */
    collapseUndo(undoDepth, label, before, anchorId) {
      const current = state.undo ?? []
      /**
       * **不能用 `current.length <= undoDepth` 判断「没有新增」**（WP6-E 复审 P1-1）。
       *
       * historyLimit 会让栈长饱和：批量落地前栈已满 20，落地 25 条后仍是 20。
       * 此时 `20 <= 20` 成立 → 直接 return，折叠完全不执行，用户要按 25 次 Cmd+Z。
       *
       * 正确判据是「锚点是否已经是栈顶」：给了 anchorId 且它就是栈尾 entry，
       * 说明本轮没有任何新 entry；否则一律执行折叠。
       */
      if (current.length === 0) return { collapsed: 0 }
      if (typeof anchorId === 'string' && anchorId !== ''
        && current[current.length - 1]?.id === anchorId) {
        return { collapsed: 0 }
      }
      /**
       * **锚点优先于栈深**（WP6-D 真机缺陷修复）。
       *
       * `commit` 每次 push 都做 `slice(-historyLimit)` 裁剪。当栈接近上限时，
       * 批量落地会把最初的几条历史挤掉，于是 `undoDepth`（裁剪前的深度）
       * 在裁剪后的栈里指向了错误位置 —— `slice(0, undoDepth)` 保留的是
       * 错位的历史，且折叠用的 `before` 快照也可能对不上。
       *
       * 调用方在批量落地前记下「栈顶 entry 的 id」，这里用它在**裁剪后**
       * 的栈里定位真正的分界点；找不到锚点才回落到栈深。
       */
      let keptLength = undoDepth
      if (typeof anchorId === 'string' && anchorId !== '') {
        const idx = current.findIndex((e) => e.id === anchorId)
        if (idx >= 0) keptLength = idx + 1
      }
      const kept = current.slice(0, keptLength)
      const collapsed = current.length - keptLength
      const entry = { id: randomUUID(), label, at: now().toISOString(), before: structuredClone(before) }
      const next = { ...state, undo: [...kept, entry], redo: [] }
      // 不写 journal：这只是历史记账，不是业务数据变更
      writeFileDurable(file, JSON.stringify({ ...next, updatedAt: now().toISOString() }, null, 2))
      state = { ...next, updatedAt: now().toISOString() }
      return { collapsed }
    },
    /** 整体替换（导入用）；调用方负责先 backup。 */
    replace(next) {
      return commit(next, { intent: 'replace' })
    },
    dataDir: dir,
    _internal: { validateShape, readJson, writeFileDurable, ensureDirs },
  }
}

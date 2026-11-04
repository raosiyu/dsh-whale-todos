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
})

const MAX_BACKUPS = 20

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * @param {string} dir 数据目录
 * @param {{ now?: () => Date, maxBackups?: number }} [options]
 */
export function openStore(dir, options = {}) {
  const now = options.now ?? (() => new Date())
  const maxBackups = options.maxBackups ?? MAX_BACKUPS
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
    return data
  }

  const listBackups = () =>
    existsSync(backupDir)
      ? readdirSync(backupDir)
          .filter((name) => /^\d+-.*\.json$/.test(name))
          .sort()
      : []

  const snapshot = (data) => {
    ensureDirs()
    const seq = String(listBackups().length + 1).padStart(4, '0')
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const target = join(backupDir, `${seq}-${stamp}.json`)
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
      const backups = listBackups()
      if (backups.length > 0) {
        const latest = readJson(join(backupDir, backups[backups.length - 1]))
        validateShape(latest, join(backupDir, backups[backups.length - 1]))
        writeFileDurable(file, JSON.stringify(latest, null, 2))
        rmSync(journalFile, { force: true })
        return latest
      }
      rmSync(journalFile, { force: true })
    }
    return validateShape(readJson(file), file)
  }

  let state = load()

  const commit = (next, meta) => {
    ensureDirs()
    validateShape(next, 'commit')
    snapshot(state)
    writeFileDurable(
      journalFile,
      JSON.stringify({ intent: meta?.intent ?? 'write', at: now().toISOString(), target: file }, null, 2),
    )
    const stamped = { ...next, updatedAt: now().toISOString() }
    writeFileDurable(file, JSON.stringify(stamped, null, 2))
    rmSync(journalFile, { force: true })
    state = stamped
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
      const target = snapshot(state)
      return { path: target, label, at: now().toISOString() }
    },
    listBackups,
    /** 从最近一份（或指定）备份回滚。 */
    rollback(backupName) {
      const backups = listBackups()
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
      return { restored: target, at: now().toISOString() }
    },
    /** 内容指纹（导出/导入校验用）。 */
    fingerprint() {
      return sha256(JSON.stringify({ version: state.version, events: state.events, tasks: state.tasks }))
    },
    /** 整体替换（导入用）；调用方负责先 backup。 */
    replace(next) {
      return commit(next, { intent: 'replace' })
    },
    dataDir: dir,
    _internal: { validateShape, readJson, writeFileDurable, ensureDirs },
  }
}

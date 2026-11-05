/**
 * **WP3 Host Service 适配层**。
 *
 * ## 定位
 *
 * 把 WP1/WP2 已验证的 `createWorkbenchService`（唯一业务门面）挂到 DSH Host：
 *
 *   ctx.provide('workbench', createWorkbenchHostService({ rootDir, approval }))
 *
 * 之后 UI 与 Agent 工具都通过 `ctx.workbench.forSession(sessionId, scope)`
 * 拿到**同一个门面实例**，调用同一个 `execute(op, payload, meta)`。
 *
 * ## 为什么单独一层
 *
 * - `workbench-core` 保持**零 DSH 依赖**（可在纯 Node 下测试）；DSH 相关
 *   （`ctx`、`agent.session.id`、`ctx.approval`）只在 `apply()` 时注入。
 * - sessionId / scope 隔离在这里做，不污染业务门面：每个 session 一个
 *   独立 dataDir 子目录，文件存储天然隔离；scope 作为一等字段透传。
 * - 审批：`host` 模式把 `ctx.approval.request` 注入 approval-gate，
 *   凭证由**真宿主**签发；工具层拿不到 issuer，无法自造 token。
 *
 * ## 不做什么
 *
 * - 不注册工具（那是 `workbench-core/src/host-tools.js`）。
 * - 不改 `~/.dsh` 用户数据；dataDir 由宿主显式传入。
 * - 不迁移任何既有 Task/Event 数据。
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createWorkbenchService } from './service.js'

/** 把 sessionId 压成安全的目录名（不暴露原文、避免路径穿越）。 */
function sessionDirName(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('sessionId 必须是非空字符串')
  }
  return `s-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
}

/**
 * 创建 Host Service 实例。
 *
 * @param {{
 *   rootDir: string,
 *   // 真宿主审批请求：由 apply() 从 ctx.approval.request 注入
 *   requestApproval?: (req) => Promise<'approved'|'denied'|'unavailable'>,
 *   mode?: 'host'|'isolated'|'deny',
 *   allowIsolated?: boolean,
 *   now?: () => number,
 * }} options
 */
export function createWorkbenchHostService(options = {}) {
  const {
    rootDir,
    requestApproval,
    mode = 'host',
    allowIsolated = false,
    now,
  } = options

  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('rootDir 必须是非空字符串')
  }
  mkdirSync(rootDir, { recursive: true })

  /** sessionId → 该会话的门面实例。 */
  const sessions = new Map()

  /** 每次调用的审计流水（进程内，供 UI/工具读取；持久化审计在 service 内）。 */
  const auditTrail = []
  let auditSeq = 0

  function record(entry) {
    auditTrail.push({
      seq: ++auditSeq,
      atMs: now ? now() : Date.now(),
      ...entry,
    })
    // 上限保护：只保留最近 2000 条，避免长会话无限增长
    if (auditTrail.length > 2000) auditTrail.splice(0, auditTrail.length - 2000)
  }

  /**
   * 取（或惰性创建）某会话的业务门面。
   *
   * @param {string} sessionId 来自 `exec.agent.session.id`，**唯一可信来源**
   * @param {string} [scope]   一等字段，透传给提醒映射；不用 key 前缀
   */
  function forSession(sessionId, scope = '') {
    const dirName = sessionDirName(sessionId)
    const key = `${dirName}::${scope}`
    let svc = sessions.get(key)
    if (svc === undefined) {
      // scope 必须进**目录路径**：只作 Map key 而不分目录，会让两个 scope
      // 共用同一份文件存储（实测 events 与 tasks 各自看到 2 条 = 未隔离）。
      const scopeSuffix = scope === ''
        ? ''
        : `-${createHash('sha256').update(scope).digest('hex').slice(0, 12)}`
      const dataDir = join(rootDir, `${dirName}${scopeSuffix}`)
      mkdirSync(dataDir, { recursive: true })
      svc = createWorkbenchService({
        dataDir,
        approvalMode: mode,
        allowIsolatedApproval: allowIsolated,
        requestApproval,
        now,
        nowApproval: now,
      })
      sessions.set(key, svc)
      record({ kind: 'session-open', sessionId: dirName, scope })
    }
    return svc
  }

  /**
   * **统一业务方法**：UI 与 Agent 工具都走这里，绝不各写一套。
   *
   * @param {string} sessionId
   * @param {string} op        service.listOps() 中的一个
   * @param {unknown} payload
   * @param {{ actor?: string, scope?: string, approvalToken?: string, confirmed?: boolean }} [meta]
   */
  function invoke(sessionId, op, payload, meta = {}) {
    const scope = typeof meta.scope === 'string' ? meta.scope : ''
    const svc = forSession(sessionId, scope)
    const at = now ? now() : Date.now()

    let result
    let error
    try {
      result = svc.execute(op, payload, {
        actor: meta.actor ?? 'host-service',
        approvalToken: meta.approvalToken,
        confirmed: meta.confirmed,
      })
    } catch (e) {
      error = {
        code: e?.code ?? 'internal_error',
        message: String(e?.message ?? e),
        name: e?.name,
      }
      record({
        kind: 'op-error', sessionId: sessionDirName(sessionId), scope, op,
        actor: meta.actor ?? 'host-service', error,
      })
      throw e
    }

    record({
      kind: 'op', sessionId: sessionDirName(sessionId), scope, op,
      actor: meta.actor ?? 'host-service',
      // 只记摘要，不记 payload 全文（可能含用户数据）
      payloadKeys: payload !== null && typeof payload === 'object'
        ? Object.keys(payload).sort()
        : [],
      atMs: at,
    })
    return result
  }

  /** 只读：列出某会话可用的业务操作。 */
  function listOps(sessionId, scope = '') {
    return forSession(sessionId, scope).listOps()
  }

  /**
   * 审批申请入口（由工具层调用，凭证仍由宿主签发）。
   * 转发到 service.requestApproval(op, detail) 的**真实二参签名**。
   */
  function askApproval(sessionId, op, detail = {}) {
    const svc = forSession(sessionId)
    return svc.requestApproval(op, detail)
  }

  /** 只读：审计流水（进程内，供 UI/工具展示）。 */
  function audit({ sessionId, limit = 100 } = {}) {
    const wanted = typeof sessionId === 'string' ? sessionDirName(sessionId) : undefined
    const rows = wanted === undefined
      ? auditTrail
      : auditTrail.filter((r) => r.sessionId === wanted || r.sessionId === undefined)
    return rows.slice(-Math.min(Math.max(limit, 1), 2000)).map((r) => ({ ...r }))
  }

  /** 只读：诊断信息（不暴露内部 store / events 可写面）。 */
  function describe() {
    return Object.freeze({
      rootDir,
      mode,
      sessionCount: sessions.size,
      auditCount: auditTrail.length,
    })
  }

  return Object.freeze({
    forSession,
    invoke,
    listOps,
    askApproval,
    audit,
    describe,
  })
}

/**
 * **DSH 插件 apply**：把服务挂到 Host Context。
 *
 * 真实契约（app.asar 一手源码）：
 *   - Host Service 用 `ctx.provide('workbench', instance)`（`dsh-cmdline/lib/index.js:29`
 *     实证范式；复杂 Service 才用 `Service` 基类）
 *   - 审批走 `ctx.approval.request`（`dsh-user-approval` 的 fail-closed ask 策略）
 *
 * 本函数**不 import 任何 DSH 包**，由调用方传入 `ctx` 与配置。
 *
 * @param {{ provide: (name: string, value: unknown) => unknown }} ctx
 * @param {{ rootDir: string, approval?: { request: Function }, mode?: string }} config
 */
export function applyWorkbenchHostService(ctx, config = {}) {
  if (typeof ctx?.provide !== 'function') {
    throw new TypeError('applyWorkbenchHostService 需要带 provide 的 Host Context')
  }
  const requestApproval = config.approval?.request !== undefined
    ? async (req) => {
        // 真宿主 ask 策略：无 answerer / 失败 → unavailable（fail closed）
        const decision = await config.approval.request({
          agent: req.agent,
          tool: req.op,
          callId: req.callId,
          reason: req.summary,
          signal: req.signal,
        })
        return decision
      }
    : undefined

  const service = createWorkbenchHostService({
    rootDir: config.rootDir,
    requestApproval,
    mode: config.mode ?? 'host',
  })
  ctx.provide('workbench', service)
  return service
}

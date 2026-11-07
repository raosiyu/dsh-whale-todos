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
import { AsyncLocalStorage } from 'node:async_hooks'
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
 *   // 真宿主审批请求：由 apply() 从 ctx.approval.request 注入。
 *   // req 里带 agent（真 ApprovalService 需要 req.agent.session）。
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
    // 无显式 agent 时的兜底提供者（真 ApprovalService 需要 req.agent.session）。
    // **并发路径必须显式传 agent**；此兜底只用于单调用者场景。
    currentAgent = () => undefined,
  } = options

  /**
   * **按异步调用链**隔离当前 agent：真 ApprovalService 需要 req.agent.session，
   * 但 service.requestApproval 只透传 4 个字段（不传 detail.agent）。
   * 用 AsyncLocalStorage 而不是模块级变量——后者在并发工具调用下会串味
   * （实测 5 个并发审批全部看到 UNDEFINED / 串成同一个 agent）。
   */
  const agentStorage = new AsyncLocalStorage()

  /**
   * 把**真宿主** `ApprovalService.request` 的输出映射回 workbench-core gate
   * 的词汇，并补齐真实现要求的 `toolName` 与 `req.agent.session`。
   * 必须放在 createWorkbenchHostService 内部：它才能访问 agentStorage（并发隔离）。
   */
  const hostRequest = (typeof requestApproval === 'function')
    ? async (req) => {
        const agent = req.agent ?? agentStorage.getStore()
          ?? (typeof currentAgent === 'function' ? currentAgent() : undefined)
        if (agent === undefined || agent?.session === undefined) return 'unavailable'
        let outcome
        try {
          outcome = await requestApproval({
            agent,
            toolName: req.op,
            callId: req.callId,
            reason: req.summary,
            signal: req.signal,
          })
        } catch {
          return 'unavailable'
        }
        return outcome === 'allowed-once' ? 'approved' : 'denied'
      }
    : undefined

  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('rootDir 必须是非空字符串')
  }
  mkdirSync(rootDir, { recursive: true })

  /** sessionId → 该会话的门面实例。 */
  const sessions = new Map()

  /**
   * 目录名（`s-<sha256前缀>`）→ 原始 sessionId。
   *
   * 提醒同步需要真实 sessionId 才能调 `ctx.schedule.*`，而磁盘上只有
   * 不可逆的目录名。这张表补上那一段映射，**只在内存里**（不落盘，
   * 避免把匿名化目录名的反查表写成文件）。
   */
  const sessionIdsByDir = new Map()

  /**
   * `sessions` 的复合 key → 结构化元数据 `{sessionId, scope, dataDir}`。
   *
   * 为什么不从 key 反解析：原 `openedSessions` 用 `lastIndexOf('::')` 拆
   * `${dirName}::${scope}`，scope 自身含 `::` 时就会拆错（审查 P2-7）。
   * 结构体不存在这个歧义，也让 `dataDirFor` 不必重复实现 hash 规则。
   */
  const sessionEntries = new Map()


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
        requestApproval: hostRequest,
        now,
        nowApproval: now,
      })
      sessions.set(key, svc)
      /**
       * 记住「目录名 → 原始 sessionId」的进程内映射。
       *
       * `sessionDirName` 是 sha256 前缀，**不可逆**：磁盘上只有
       * `s-df3b…`，反推不出 `session-7f39…`。而 `ctx.schedule` 的
       * create/list/delete 全都要真实 sessionId，所以启动对账必须靠这张表。
       *
       * 只存在内存里、**不写盘**：写盘等于把 sha256 目录名的反查表落成文件，
       * 那会把「目录名匿名化」这层保护抵消掉。代价是重启后这张表为空，
       * 因此重启对账的覆盖范围是「本次进程内被打开过的 session」——
       * 其余 session 在它们各自第一次写操作时对账（见 index.js 的 handler）。
       */
      sessionIdsByDir.set(dirName, sessionId)
      sessionEntries.set(key, { sessionId, scope, dataDir })
      record({ kind: 'session-open', sessionId: dirName, scope })
    }
    return svc
  }

  /**
   * 列出本进程内已打开过的 `{sessionId, scope}`，供提醒启动对账使用。
   *
   * 只暴露 sessionId 字符串本身，不暴露目录名与它们的映射关系。
   *
   * @returns {Array<{ sessionId: string, scope: string }>}
   */
  function openedSessions() {
    const out = []
    for (const entry of sessionEntries.values()) {
      out.push({ sessionId: entry.sessionId, scope: entry.scope })
    }
    return out
  }

  /**
   * 取（或按规则推导）某 session × scope 的数据目录。
   *
   * 提醒白名单文件要放在与业务数据同一个目录里。让这里统一提供，
   * 调用方**不许自己再算一遍 sha256 前缀**（两份实现必然漂移）。
   *
   * @param {string} sessionId
   * @param {string} [scope]
   * @returns {string}
   */
  function dataDirFor(sessionId, scope = '') {
    forSession(sessionId, scope) // 确保已创建并登记
    const found = sessionEntries.get(`${sessionDirName(sessionId)}::${scope}`)
    if (found !== undefined) return found.dataDir
    // 兜底：按同一规则推导（正常路径不会走到）
    const scopeSuffix = scope === ''
      ? ''
      : `-${createHash('sha256').update(scope).digest('hex').slice(0, 12)}`
    return join(rootDir, `${sessionDirName(sessionId)}${scopeSuffix}`)
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
  function askApproval(sessionId, op, detail = {}, agent = undefined) {
    const svc = forSession(sessionId, typeof detail.scope === 'string' ? detail.scope : '')
    const effective = agent ?? (typeof currentAgent === 'function' ? currentAgent() : undefined)
    // 每个异步调用链有自己的 agent，不会互相覆盖
    return agentStorage.run(effective, () => svc.requestApproval(op, detail))
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
    openedSessions,
    dataDirFor,
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
  const service = createWorkbenchHostService({
    rootDir: config.rootDir,
    // 传**保留 receiver** 的包装（真 ApprovalService.request 用 this.decide/this.ctx），
    // 词汇映射由 createWorkbenchHostService 内部的 hostRequest 统一做（真词汇 allowed-once）。
    requestApproval: config.approval?.request !== undefined
      ? (req) => config.approval.request(req)
      : undefined,
    mode: config.mode ?? 'host',
    currentAgent: config.currentAgent,
  })
  ctx.provide('workbench', service)
  return service
}

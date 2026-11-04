/**
 * 宿主审批门（HostApprovalGate）。
 *
 * ## 为什么不能相信 payload 里的 `confirmed`
 *
 * `confirmed: true` 是模型**自己**能填的字段。若服务层直接读它，AI 就等于给自己发批文，
 * 审批形同虚设。这里把「批准」变成**宿主签发的一次性凭证**：
 *
 * 1. 调用方（UI 或 Agent 工具）先向宿主申请；宿主按策略决定是否问人。
 * 2. 宿主批准后签发 token（带操作指纹 + 有效期 + 一次性）。
 * 3. 服务层只认 token：校验指纹匹配、未过期、未使用过。
 *
 * 没有 token 就拒绝——**payload 里写什么都无效**。
 *
 * ## 三种运行模式
 *
 * - `host`：真的走宿主审批（`ctx.approval.request`）；凭证由真宿主签发。
 * - `isolated`：隔离测试用。凭证必须由**测试注入的 issuer** 签发，
 *   模型侧无法伪造（因为它拿不到 issuer 的私有 nonce）。
 * - `deny`：一律拒绝（用于只读或禁用写操作的部署）。
 *
 * 本文件不 import 任何 DSH 包，保持 `workbench-core` 零依赖；
 * 真实宿主通过 `createHostApprovalGate({ request: (req) => ... })` 注入。
 */

import { createHash, randomUUID } from 'node:crypto'

import { WorkbenchError, confirmationRequired, validationError } from './errors.js'

/** 审批模式。 */
export const APPROVAL_MODES = Object.freeze(['host', 'isolated', 'deny'])

/** 凭证默认有效期（毫秒）。 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * 操作指纹：把「对什么做什么」压成稳定摘要，防止凭证被挪用到别的操作上。
 * @param {{ op: string, target?: string, digest?: string }} input
 */
export function approvalFingerprint(input) {
  const parts = [input.op ?? '', input.target ?? '', input.digest ?? '']
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

/**
 * @param {{
 *   mode?: 'host'|'isolated'|'deny',
 *   request?: (req: {op: string, target?: string, digest?: string, summary: string}) => Promise<'approved'|'denied'|'unavailable'>,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} [options]
 */
export function createHostApprovalGate(options = {}) {
  const mode = options.mode ?? 'host'
  if (!APPROVAL_MODES.includes(mode)) {
    throw validationError(`未知审批模式：${mode}`, { mode, allowed: APPROVAL_MODES })
  }
  // isolated 会自动批准，只允许测试显式开启；生产误用等于关掉审批，必须在构造时拦住
  if (mode === 'isolated' && options.allowIsolated !== true) {
    throw validationError(
      'isolated 审批模式会自动批准，必须显式传 allowIsolated: true（仅测试可开）',
      { mode },
    )
  }
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS

  /** 已签发凭证：token → { fingerprint, expiresAt, used, issuedBy } */
  const issued = new Map()
  /** 已消费凭证（防重放）；只保留近期，避免无限增长 */
  const consumed = new Set()

  /** issuer nonce：只有创建方持有，外部无法构造合法 token（isolated 模式的关键）。 */
  const issuerNonce = randomUUID()

  const makeToken = (fingerprint, issuedBy) => {
    const raw = `${issuerNonce}:${fingerprint}:${randomUUID()}`
    const token = createHash('sha256').update(raw).digest('hex')
    issued.set(token, { fingerprint, expiresAt: now() + ttlMs, used: false, issuedBy })
    return token
  }

  return {
    mode,

    /** 当前模式是否允许写操作（`deny` 下全拒）。 */
    get writable() {
      return mode !== 'deny'
    },

    /**
     * 申请批准并发凭证。
     * @param {{ op: string, target?: string, digest?: string, summary: string }} req
     * @returns {Promise<{ approved: boolean, token?: string, reason?: string }>}
     */
    async request(req) {
      if (mode === 'deny') {
        return { approved: false, reason: 'approval-mode-deny' }
      }
      const fingerprint = approvalFingerprint(req)
      if (mode === 'isolated') {
        // 隔离模式：凭证由本 gate 签发（测试注入），不询问真人
        return { approved: true, token: makeToken(fingerprint, 'isolated') }
      }
      // host 模式：交给宿主决定
      if (typeof options.request !== 'function') {
        return { approved: false, reason: 'host-requester-missing' }
      }
      let outcome
      try {
        outcome = await options.request({ ...req, fingerprint })
      } catch (error) {
        return { approved: false, reason: `host-error:${String(error?.message ?? error)}` }
      }
      if (outcome !== 'approved') return { approved: false, reason: `host-${outcome ?? 'unknown'}` }
      return { approved: true, token: makeToken(fingerprint, 'host') }
    },

    /**
     * 校验并消费凭证。**服务层唯一认的批准依据**。
     *
     * @param {{ op: string, target?: string, digest?: string }} req
     * @param {string|undefined} token
     * @returns {{ ok: true } | { ok: false, reason: string }}
     */
    verify(req, token) {
      if (mode === 'deny') return { ok: false, reason: 'approval-mode-deny' }
      if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing-token' }
      const record = issued.get(token)
      if (record === undefined) return { ok: false, reason: 'unknown-token' }
      if (record.used) return { ok: false, reason: 'token-already-used' }
      if (record.expiresAt <= now()) return { ok: false, reason: 'token-expired' }
      const expected = approvalFingerprint(req)
      if (record.fingerprint !== expected) return { ok: false, reason: 'fingerprint-mismatch' }
      record.used = true
      issued.delete(token)
      consumed.add(token)
      return { ok: true }
    },

    /** 内部检查（测试用）：某 token 是否已消费。 */
    wasConsumed(token) {
      return consumed.has(token)
    },

    /**
     * 便捷方法：申请 + 立即校验（同一调用内完成）。
     * @param {{ op: string, target?: string, digest?: string, summary: string }} req
     */
    async authorize(req) {
      const res = await this.request(req)
      if (res.approved !== true || res.token === undefined) {
        throw confirmationRequired(`操作 ${req.op} 未获得宿主批准：${res.reason ?? 'denied'}`, {
          op: req.op,
          reason: res.reason,
        })
      }
      const check = this.verify(req, res.token)
      if (!check.ok) {
        throw confirmationRequired(`操作 ${req.op} 的批准凭证无效：${check.reason}`, {
          op: req.op,
          reason: check.reason,
        })
      }
      return { token: res.token }
    },
  }
}

/** 供服务层构造「需要审批」错误的标准形态。 */
export function approvalRequiredError(op, reason) {
  return new WorkbenchError('confirmation-required', `操作 ${op} 需要宿主审批（${reason}）`, { op, reason })
}

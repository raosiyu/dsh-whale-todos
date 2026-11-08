/**
 * WP6-A · 规划提案数据模型与校验（纯函数，零 DSH 依赖）。
 *
 * ## 为什么单独成模块
 *
 * 提案的「生成 → 校验 → 确认 → 落库」四阶段里，除了 store 读写，其余都是
 * 确定性纯逻辑。抽出来有三点收益：
 *  - 工具层 / service 层 / UI 层共用**同一套校验**（Dely0 dailyPlanPolicy 的
 *    「单一权威口径」模式，不许各算一遍）；
 *  - 纯函数可穷举单测，不必启动 Host；
 *  - AI 生成的文本在这里被明确标注为**不可信输入**，集中做净化。
 *
 * ## 红线
 *
 * 1. 提案 payload 绝不直接透传给 service.execute —— apply 时逐条重校验。
 * 2. 提案绑定 baseVersion / baseDigest / 每条 targetId，防确认后数据被替换。
 * 3. `reasoning` / `sourceText` / item.reason 全部是不可信文本，只展示不执行。
 * 4. 本模块不写任何数据，只返回结构化对象供调用方持久化。
 */

/** 允许提案落地的 op 白名单（AI 不能借提案绕过审批去调危险 op）。 */
export const PROPOSAL_ALLOWED_OPS = Object.freeze([
  'task.create',
  'task.update',
  'event.create',
])

/** 提案种类。 */
export const PROPOSAL_KINDS = Object.freeze(['plan', 'decompose', 'schedule', 'mixed'])

/** 提案状态。 */
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'applied', 'rejected', 'expired'])

/** AI 文本存储上限（不可信输入，防膨胀）。 */
export const MAX_TEXT_LEN = 2000

/** 单个提案最多多少条 item（防一次确认批量覆盖）。 */
export const MAX_ITEMS = 50

/** 预计耗时合法区间（对齐 Dely0 dailyPlanPolicy）。 */
export const MIN_ESTIMATE_MINUTES = 1
export const MAX_ESTIMATE_MINUTES = 1440

/** 会话关联角色。 */
export const SESSION_ROLES = Object.freeze(['clarify', 'decompose', 'execute', 'review', 'other'])

/** 内部错误（与 service 的 validation 语义一致，由调用方转成 WorkbenchError）。 */
export class ProposalValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ProposalValidationError'
    this.code = 'validation'
    this.details = details
  }
}

function fail(message, details) {
  throw new ProposalValidationError(message, details)
}

/**
 * 净化不可信文本：截断 + 去控制字符（保留换行/tab）。
 *
 * **不**剥离 HTML / 不解析指令 —— 这里只做存储前的边界控制；
 * 「不当作指令执行」的保证来自调用方：这些字段永远不进工具描述、不进命令、
 * 不参与任何分支判断，只作为展示字符串。
 *
 * @param {unknown} raw
 * @param {number} [limit]
 * @returns {string}
 */
export function sanitizeUntrustedText(raw, limit = MAX_TEXT_LEN) {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned
}

/**
 * 校验预计耗时。Dely0 口径：显式输入非法则**整份拒绝**（不静默回落）。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function checkEstimateMinutes(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    fail('预计耗时必须是有限数字', { got: typeof value })
  }
  if (!Number.isInteger(value)) fail('预计耗时必须是整数分钟', { value })
  if (value < MIN_ESTIMATE_MINUTES || value > MAX_ESTIMATE_MINUTES) {
    fail(`预计耗时必须在 ${MIN_ESTIMATE_MINUTES}..${MAX_ESTIMATE_MINUTES} 分钟`, { value })
  }
  return value
}

/**
 * 构造一条提案 item（绑定具体操作）。
 *
 * @param {object} raw - 不可信输入
 * @returns {{op:string, targetId?:string, targetVersion?:number, payload:object, reason:string}}
 */
export function buildProposalItem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('提案 item 必须是对象')
  }
  const op = raw.op
  if (!PROPOSAL_ALLOWED_OPS.includes(op)) {
    fail(`提案 op 不在允许清单内：${String(op)}`, { op, allowed: [...PROPOSAL_ALLOWED_OPS] })
  }
  const payload = raw.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('提案 item.payload 必须是对象')
  }
  // 只保留已知字段，杜绝不可信输入夹带私有字段（如 confirmed / approvalToken / deleted）
  const safePayload = pickPayload(op, payload)
  // 落地前的第一道校验：标题必填。AI 生成的空标题不能混进提案。
  // （apply 时还会再过 validateTaskInput / validateEventInput，双保险）
  if (typeof safePayload.title !== 'string' || safePayload.title.trim() === '') {
    fail('提案 item 必须提供非空 title', { op })
  }
  const item = {
    op,
    payload: safePayload,
    reason: sanitizeUntrustedText(raw.reason),
  }
  if (op === 'task.update') {
    const targetId = raw.targetId
    if (typeof targetId !== 'string' || targetId === '') {
      fail('task.update 必须绑定 targetId')
    }
    item.targetId = targetId
    // targetDigest 由 proposal.preview 在生成时回填（apply 时比对，防目标被替换）
    if (typeof raw.targetDigest === 'string' && raw.targetDigest !== '') {
      item.targetDigest = raw.targetDigest
    }
    if (raw.targetVersion !== undefined) {
      if (!Number.isInteger(raw.targetVersion) || raw.targetVersion < 0) {
        fail('targetVersion 必须是非负整数')
      }
      item.targetVersion = raw.targetVersion
    }
  }
  return item
}

/**
 * 按 op 白名单裁剪 payload 字段。
 *
 * 这是「AI 生成内容视为不可信输入」的核心落点：
 * 即便模型夹带了 `confirmed:true` / `approvalToken` / `deleted` / `id`，
 * 也在这里被丢弃，不会流入 service.execute。
 *
 * @param {string} op
 * @param {object} raw
 * @returns {object}
 */
export function pickPayload(op, raw) {
  const TASK_FIELDS = [
    'title', 'dueAt', 'priority', 'status', 'project', 'subtasks',
    'estimatedMinutes',
  ]
  const EVENT_FIELDS = [
    'title', 'description', 'location', 'allDay', 'start', 'end',
    'startDate', 'endDate', 'timeZone', 'recurrence', 'excludeDates',
  ]
  const allowed = op === 'event.create' ? EVENT_FIELDS : TASK_FIELDS
  const out = {}
  for (const key of allowed) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  // 事件必须带 allDay（既有 service 的硬要求）
  if (op === 'event.create' && out.allDay === undefined) out.allDay = false
  return out
}

/**
 * 构造一份提案（**只造对象，不写任何数据**）。
 *
 * @param {{
 *   kind?: string, sessionId: string, scope?: string, sourceText?: unknown,
 *   reasoning?: unknown, items: unknown[], conflicts?: unknown[],
 *   baseVersion: number, baseDigest: string,
 *   idFactory?: () => string, now?: () => Date,
 * }} input
 * @returns {object} Proposal
 */
export function buildProposal(input) {
  if (input === null || typeof input !== 'object') fail('提案输入必须是对象')
  const sessionId = input.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    fail('提案必须绑定 sessionId（唯一来源 exec.agent.session.id）')
  }
  const kind = input.kind ?? 'plan'
  if (!PROPOSAL_KINDS.includes(kind)) fail(`未知的提案种类：${String(kind)}`, { kind })
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    fail('baseVersion 必须是非负整数')
  }
  if (typeof input.baseDigest !== 'string' || input.baseDigest === '') {
    fail('baseDigest 必须绑定')
  }
  const rawItems = Array.isArray(input.items) ? input.items : []
  if (rawItems.length === 0) fail('提案至少要有一条 item')
  if (rawItems.length > MAX_ITEMS) {
    fail(`单份提案最多 ${MAX_ITEMS} 条 item`, { count: rawItems.length })
  }
  const items = rawItems.map((raw, index) => {
    try {
      return buildProposalItem(raw)
    } catch (error) {
      if (error instanceof ProposalValidationError) {
        fail(`提案 items[${index}] 非法：${error.message}`, { index, ...error.details })
      }
      throw error
    }
  })
  const idFactory = input.idFactory ?? (() => `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  const at = (input.now ?? (() => new Date()))().toISOString()
  return {
    id: idFactory(),
    kind,
    status: 'pending',
    sessionId,
    scope: typeof input.scope === 'string' ? input.scope : '',
    sourceText: sanitizeUntrustedText(input.sourceText),
    reasoning: sanitizeUntrustedText(input.reasoning),
    items,
    conflicts: Array.isArray(input.conflicts) ? input.conflicts.slice(0, MAX_ITEMS) : [],
    baseVersion: input.baseVersion,
    baseDigest: input.baseDigest,
    createdAt: at,
  }
}

/**
 * apply 前的**绑定校验**：确认数据自提案生成后没被替换。
 *
 * @param {object} proposal
 * @param {{ version:number, digest:string, sessionId:string, scope:string }} current
 * @returns {{ ok:true } | { ok:false, reason:string }}
 */
export function verifyProposalBinding(proposal, current) {
  if (proposal === null || typeof proposal !== 'object') {
    return { ok: false, reason: 'proposal-missing' }
  }
  if (proposal.status !== 'pending') {
    return { ok: false, reason: `proposal-not-pending:${String(proposal.status)}` }
  }
  /**
   * **sessionId 不相等不是拒绝理由**（WP6-E 实测修正）。
   *
   * 产品主路径就是「Agent 生成提案 → 用户在 UI 确认落地」，两者天然不是同一个
   * session。若在这里硬拒，整条 AI 协作链路在真实使用中直接不可用
   * （实测：Agent 生成、用户确认 → conflict/session-mismatch）。
   *
   * 安全边界并没有放松：
   *  - 落地本身要求**Host 签发的一次性审批 token**（requireConfirmation 已校验，
   *    只有真人在 UI 上点了确认才会签发）；
   *  - scope 必须一致（下面仍然校验），禁止跨 scope 越权；
   *  - baseVersion / baseDigest 仍然绑定，防确认后数据被替换。
   *
   * 因此这里只把 sessionId 作为**信息**保留，不作为拒绝条件。
   */
  if ((proposal.scope ?? '') !== (current.scope ?? '')) {
    return { ok: false, reason: 'scope-mismatch' }
  }
  /**
   * `skipGlobalDigest`：跨工作区落地时跳过全局版本/摘要校验。
   *
   * 提案的 baseVersion/baseDigest 描述的是**创建者工作区**的状态；用户在自己
   * 的工作区落地时必然不同。此时防替换责任交给每条 `task.update` 的
   * `targetDigest`（apply 里逐条比对）。同工作区不跳过，语义不变。
   */
  if (current.skipGlobalDigest !== true) {
    if (proposal.baseVersion !== current.version) {
      return { ok: false, reason: 'base-version-mismatch' }
    }
    if (proposal.baseDigest !== current.digest) {
      return { ok: false, reason: 'base-digest-mismatch' }
    }
  }
  return { ok: true }
}

/**
 * 构造会话关联条目（校验 role 与 sessionId 格式）。
 *
 * @param {{ sessionId: string, role?: string, note?: unknown, now?: () => Date }} input
 * @returns {{sessionId:string, role:string, note:string, at:string}}
 */
export function buildSessionLink(input) {
  const sessionId = input?.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    fail('会话关联必须提供非空 sessionId')
  }
  if (sessionId.length > 200) fail('sessionId 过长')
  const role = input.role ?? 'other'
  if (!SESSION_ROLES.includes(role)) fail(`未知的会话角色：${String(role)}`, { role })
  return {
    sessionId,
    role,
    note: sanitizeUntrustedText(input.note, 500),
    at: (input.now ?? (() => new Date()))().toISOString(),
  }
}

/**
 * 验收申请（AI 只能建草稿，不能置 done）。
 *
 * @param {{summary:unknown, sessionId:string, now?:()=>Date}} input
 * @returns {{status:'pending', summary:string, requestedAt:string, requestedBy:string}}
 */
export function buildCompletionRequest(input) {
  const summary = sanitizeUntrustedText(input?.summary, 1000)
  if (summary.trim() === '') fail('完成验收申请必须提供 summary')
  if (typeof input?.sessionId !== 'string' || input.sessionId === '') {
    fail('完成验收申请必须绑定 sessionId')
  }
  return {
    status: 'pending',
    summary,
    requestedAt: (input.now ?? (() => new Date()))().toISOString(),
    requestedBy: input.sessionId,
  }
}

/**
 * 进度回写校验：0..99，**100 不是进度**（Dely0 模式，完成走验收申请）。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function checkProgress(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail('进度必须是整数')
  }
  if (value < 0 || value > 99) {
    fail('进度必须在 0..99；完成请走完成验收申请，不能自行置 100', { value })
  }
  return value
}

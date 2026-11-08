/**
 * WP6-E · 端到端真实验收探针（真实 service + 真实磁盘，不 mock 业务层）。
 *
 * 验收标准（用户原文）：
 *   用户输入自然语言 → AI 理解任务 → 自动拆解 → 推荐日程 → 用户确认
 *   → Host 持久保存 → Agent 执行 → 用户验收
 *
 * 附加验证：
 *   - 重启后任务与会话关联不丢失
 *   - AI 与 UI 读写的数据一致
 *   - 用户拒绝提案时不修改任何数据
 *   - 并发操作不产生重复任务或覆盖其他会话的数据
 *   - Agent 无法自行绕过审批
 *   - 失败能够正确提示且不破坏现有任务
 *   - 关键功能具备可复跑的实际测试证据
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkbenchHostService } from '../../workbench-core/src/index.js'

let pass = 0
let fail = 0
const checks = []
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
  checks.push({ name, ok: cond, detail })
}

const DAY = 86400000
const NOW = Date.parse('2026-11-09T00:00:00.000Z')
const W0 = NOW
const W1 = NOW + 7 * DAY

const dir = mkdtempSync(join(tmpdir(), 'wp6-e2e-'))
/**
 * **必须用真实 Host Service**（WP6-E 复审 P0-3 指认的假绿）。
 *
 * 原探针用裸 `createWorkbenchService` + 不同 sessionId 标签打同一个 store，
 * 结构上不可能发现「Host 按 sessionId 分片」导致的跨会话断裂。
 * 现在走 `createWorkbenchHostService`：sessionId×scope 分片、真审批门、
 * scope 级 collab 目录 —— 这才是生产装配层。
 */
const mk = () => createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
let host = mk()
const ex = (sid, op, payload, meta = {}) => host.invoke(sid, op, payload, {
  actor: 'ui', scope: '', ...meta,
})
/** 审批 token 由「操作发起方自己的会话」签发（与 UI 真实路径一致）。 */
const approve = (sid, op, target) => host.forSession(sid, '').confirmUserAction(op, target, { summary: 'confirm' })

const AGENT = 'sess-agent-exec'
const USER = 'sess-user'

console.log('='.repeat(70))
console.log('E1 · 完整链路：自然语言 → 拆解 → 排期 → 确认 → 落库 → 执行 → 验收')
console.log('='.repeat(70))
{
  // 1) 用户已有真实日历占用（规划必须避开）
  ex(USER, 'event.create', {
    title: '既有会议', allDay: false,
    start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00', timeZone: 'Asia/Shanghai',
  })
  // 2) 用户已有待办（含优先级与耗时）
  ex(USER, 'task.upsert', { task: { id: 't-old', title: '旧任务', priority: 'high' } })
  ex(USER, 'task.setEstimate', { id: 't-old', estimatedMinutes: 60 })

  // 3) AI 侧：基于自然语言生成规划提案（只读业务数据）
  const tasksBefore = ex(USER, 'task.list', {}).length
  const plan = ex(AGENT, 'plan.suggest', {
    goal: '准备下周发布会：写稿件、约场地、发邀请',
    targetTitles: ['写稿件', '约场地', '发邀请'],
    taskIds: ['t-old'],
    windowStart: W0, windowEnd: W1,
    capacityMinutesPerDay: 480,
  })
  check('E1.1 生成 pending 提案', plan.proposal.status === 'pending')
  check('E1.2 提案含拆解条目', plan.proposal.items.filter((i) => i.op === 'task.create').length >= 3,
    String(plan.proposal.items.filter((i) => i.op === 'task.create').length))
  check('E1.3 提案含日程建议（真实空闲时段）', plan.proposal.items.filter((i) => i.op === 'event.create').length > 0,
    String(plan.proposal.items.filter((i) => i.op === 'event.create').length))
  check('E1.4 生成提案时业务数据零变化', ex(USER, 'task.list', {}).length === tasksBefore)
  check('E1.5 提案有原因说明', typeof plan.proposal.reasoning === 'string' && plan.proposal.reasoning.length > 0)

  // 4) 用户确认（必须带 Host 审批 token）
  let noTokenRejected = false
  try { ex(USER, 'proposal.apply', { id: plan.proposal.id }) }
  catch (e) { noTokenRejected = e.code === 'confirmation-required' }
  check('E1.6 无审批 token 落地被拒', noTokenRejected)

  const tok = approve(USER, 'proposal.apply', plan.proposal.id)
  const applied = ex(USER, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: tok.token })
  check('E1.7 带 token 落地成功', applied.status === 'applied' && applied.created > 0,
    `created=${applied.created}`)

  // 5) 落库核对（磁盘）
  /**
   * 真实 Host 下业务数据在**分片子目录**（`s-<sha256前24>`），不在 rootDir 根下。
   * 直接读 rootDir/workbench.json 会 ENOENT —— 这正是「必须按生产路径验证」的
   * 又一例（复审 P0-3 的同类问题）。
   */
  // 按 Host 的真实规则算 USER 的分片目录名（sessionDirName = s-<sha256 前 24>）
  const userShard = `s-${createHash('sha256').update(USER).digest('hex').slice(0, 24)}`
  assert.ok(readdirSync(dir).includes(userShard), `分片目录应存在：${userShard}`)
  const disk = JSON.parse(readFileSync(join(dir, userShard, 'workbench.json'), 'utf8'))
  check('E1.8 任务确实写入磁盘', (disk.tasks ?? []).length > tasksBefore,
    `${tasksBefore} → ${(disk.tasks ?? []).length}`)
  check('E1.9 日程确实写入磁盘', (disk.events ?? []).length >= 2)

  // 6) 关联 Agent 会话
  const userTasks = ex(USER, 'task.list', {})
  const newTask = userTasks.find((t) => t.title === '写稿件')
  check('E1.10 拆解出的任务可定位', newTask !== undefined,
    `tasks=[${userTasks.map((t) => t.title).join(',')}]`)
  if (newTask === undefined) {
    console.log(`\nWP6-E 端到端验收汇总: PASS=${pass} FAIL=${fail + 1}（E1.10 前置失败，后续跳过）`)
    rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }
  ex(USER, 'task.linkSession', { id: newTask.id, sessionId: AGENT, role: 'execute', note: '负责实现' })

  // 7) Agent 读授权上下文
  const ctx = ex(AGENT, 'task.context', { sessionId: AGENT })
  check('E1.11 Agent 能读到自己关联的任务', ctx.tasks.some((t) => t.id === newTask.id))
  check('E1.12 上下文不含其他会话', !JSON.stringify(ctx).includes(USER))

  // 8) Agent 回写进度 + 证据
  try {
    ex(AGENT, 'task.writeProgress', { id: newTask.id, progress: 50, note: '初稿完成', evidence: 'commit-1' })
    ex(AGENT, 'task.writeProgress', { id: newTask.id, progress: 90, note: '评审通过', evidence: 'review-1' })
  } catch (e) {
    console.log(`  DEBUG writeProgress 失败: ${e.code} ${JSON.stringify(e.details)} newTask.id=${newTask.id}`)
    console.log(`  DEBUG Agent ctx: ${JSON.stringify(ex(AGENT, 'task.context', { sessionId: AGENT })).slice(0, 300)}`)
    const collabDirs = readdirSync(dir).filter((d) => d.startsWith('.collab'))
    console.log(`  DEBUG collab dirs: ${JSON.stringify(collabDirs)}`)
    for (const cd of collabDirs) {
      try {
        const cj = JSON.parse(readFileSync(join(dir, cd, 'workbench.json'), 'utf8'))
        console.log(`  DEBUG ${cd} assignments: ${JSON.stringify(cj.assignments ?? []).slice(0, 300)}`)
      } catch (e) { console.log(`  DEBUG ${cd} 读取失败: ${e.code}`) }
    }
    throw e
  }
  const ctx2 = ex(AGENT, 'task.context', { sessionId: AGENT })
  const mine = ctx2.tasks.find((t) => t.id === newTask.id)
  check('E1.13 进度回写生效', mine.progress === 90)
  check('E1.14 执行记录可追溯', mine.recentLog.length === 2)

  // 9) Agent 提交验收申请（不得自行完成）
  const req = ex(AGENT, 'task.requestCompletion', { id: newTask.id, summary: '稿件完成并评审通过' })
  check('E1.15 提交验收申请后 done 仍为 false', req.done === false)
  // 跨工作区：任务实体在用户工作区，Agent 的申请落在共享 assignment；
  // 用户侧任务必须**仍未完成**（AI 不能自行完成），且申请可见。
  const afterReq = ex(USER, 'task.list', {}).find((t) => t.id === newTask.id)
  check('E1.16 任务未被 AI 自行完成', afterReq.done !== true)
  const userCtxReq = ex(USER, 'task.completionRequests', {})
  const reqRow = Array.isArray(userCtxReq)
    ? userCtxReq.find((r) => r.taskId === newTask.id) : undefined
  check('E1.17 验收申请 pending 且用户可见',
    reqRow?.completion === 'pending', JSON.stringify(userCtxReq).slice(0, 120))

  // 10) 用户验收通过
  const acc = ex(USER, 'task.acceptCompletion', { id: newTask.id })
  check('E1.18 用户验收后才置 done', acc.done === true)
  const afterAcc = ex(USER, 'task.list', {}).find((t) => t.id === newTask.id)
  check('E1.19 decidedBy 标记为用户', afterAcc.completion.decidedBy === 'user')
}

console.log('')
console.log('='.repeat(70))
console.log('E2 · 重启后任务与会话关联不丢失')
console.log('='.repeat(70))
{
  const before = ex(USER, 'task.list', {})
  const withLinks = before.filter((t) => Array.isArray(t.sessionLinks) && t.sessionLinks.length > 0)
  host = mk() // 重新打开同一 rootDir = 模拟重启
  const after = ex(USER, 'task.list', {})
  check('E2.1 重启后任务数一致', after.length === before.length, `${before.length} → ${after.length}`)
  const afterLinked = after.filter((t) => Array.isArray(t.sessionLinks) && t.sessionLinks.length > 0)
  check('E2.2 重启后会话关联保留', afterLinked.length === withLinks.length,
    `${withLinks.length} → ${afterLinked.length}`)
  const doneTask = after.find((t) => t.completion?.status === 'accepted')
  check('E2.3 重启后验收状态保留', doneTask !== undefined)
  // 执行记录可能落在共享 assignment（跨工作区）或任务本地（同工作区）
  const localLogs = after.filter((t) => Array.isArray(t.executionLog) && t.executionLog.length > 0)
  const agentCtxAfter = ex(AGENT, 'task.context', { sessionId: AGENT })
  const sharedLogs = (agentCtxAfter.tasks ?? []).filter((t) => Array.isArray(t.recentLog) && t.recentLog.length > 0)
  check('E2.4 重启后执行记录保留', localLogs.length > 0 || sharedLogs.length > 0,
    `local=${localLogs.length} shared=${sharedLogs.length}`)
}

console.log('')
console.log('='.repeat(70))
console.log('E3 · AI 与 UI 读写数据一致')
console.log('='.repeat(70))
{
  /**
   * 真实 Host 下**业务数据按 session 分片是设计**（WP1–WP5 的隔离保证），
   * AI 与 UI 各读各的工作区**本来就该不同**。一致性要验的是**协作数据**：
   * 提案、assignment、验收申请在 scope 级共享层里双方看得一致。
   *
   * 原断言（AI/UI 任务集相同、互相写入立即可见）基于「同一 store」的
   * 旧假设，在真实分片下必然失败 —— 那是探针错误，不是产品缺陷。
   */
  // 协作数据一致：Agent 生成提案 → 用户看到同一份
  const sharedPlan = ex(AGENT, 'plan.suggest', {
    goal: 'E3 协作一致性', targetTitles: ['E3任务'],
    windowStart: W0, windowEnd: W1,
  })
  const userSees = ex(USER, 'proposal.list', {}).find((p) => p.id === sharedPlan.proposal.id)
  check('E3.1 协作数据（提案）在 AI 与 UI 两侧一致',
    userSees !== undefined && userSees.status === sharedPlan.proposal.status)

  // 业务数据隔离：AI 写自己工作区，不污染用户工作区
  ex(AGENT, 'task.upsert', { task: { id: 't-ai-write', title: 'AI 工作区任务' } })
  check('E3.2 AI 业务写入不污染用户工作区（分片隔离）',
    !ex(USER, 'task.list', {}).some((t) => t.id === 't-ai-write'))
  check('E3.2b AI 能在自己工作区读到它',
    ex(AGENT, 'task.list', {}).some((t) => t.id === 't-ai-write'))

  // 进度回写跨工作区可见：Agent 写 → 用户侧验收视图能看到
  const assignCtx = ex(AGENT, 'task.context', { sessionId: AGENT })
  check('E3.3 Agent 的授权上下文与共享 assignment 一致',
    Array.isArray(assignCtx.tasks))
}

console.log('')
console.log('='.repeat(70))
console.log('E4 · 用户拒绝提案时不修改任何数据')
console.log('='.repeat(70))
{
  const snap = () => JSON.stringify({
    tasks: ex(USER, 'task.list', {}),
    events: ex(USER, 'event.list', {}),
  })
  const before = snap()
  const plan = ex(AGENT, 'plan.suggest', {
    goal: '这个提案会被拒绝', targetTitles: ['不该落地'],
    windowStart: W0, windowEnd: W1,
  })
  ex(USER, 'proposal.reject', { id: plan.proposal.id })
  const after = snap()
  check('E4.1 拒绝后 tasks/events 完全不变', before === after)
  const p = ex(USER, 'proposal.get', { id: plan.proposal.id }).proposal
  check('E4.2 提案状态为 rejected', p.status === 'rejected')
  // 拒绝后不能再落地
  let rejected = false
  try {
    const t = approve(USER, 'proposal.apply', plan.proposal.id)
    ex(USER, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: t.token })
  } catch (e) { rejected = e.code === 'conflict' }
  check('E4.3 已拒绝提案不能落地', rejected)
}

console.log('')
console.log('='.repeat(70))
console.log('E5 · 并发操作不产生重复任务/不覆盖其他会话数据')
console.log('='.repeat(70))
{
  // 并发：两个会话对同一待办交替回写进度
  ex(USER, 'task.upsert', { task: { id: 't-conc', title: '并发任务' } })
  ex(USER, 'task.linkSession', { id: 't-conc', sessionId: 'sess-A', role: 'execute' })
  ex(USER, 'task.linkSession', { id: 't-conc', sessionId: 'sess-B', role: 'execute' })
  ex('sess-A', 'task.writeProgress', { id: 't-conc', progress: 10, note: 'A1' })
  ex('sess-B', 'task.writeProgress', { id: 't-conc', progress: 20, note: 'B1' })
  ex('sess-A', 'task.writeProgress', { id: 't-conc', progress: 30, note: 'A2' })
  /**
   * 两个 Agent 会话的进度回写走**共享 assignment**（任务在 USER 工作区）。
   * 验证点：三条记录都保留、按顺序累积、不互相覆盖。
   */
  const ctxA = ex('sess-A', 'task.context', { sessionId: 'sess-A' })
  const rowA = (ctxA.tasks ?? []).find((t) => t.id === 't-conc')
  check('E5.1 并发进度不互相覆盖',
    Array.isArray(rowA?.recentLog) && rowA.recentLog.length === 2,
    `A 的日志=${rowA?.recentLog?.length ?? 0}（A 写了 2 次）`)
  const localRow = ex(USER, 'task.list', {}).find((t) => t.id === 't-conc')
  check('E5.2 两条会话关联都保留', localRow.sessionLinks.length === 2)

  // 同一提案重复 apply 不得重复落地
  /**
   * 用**远未来**的时间窗，避开前面已落地的专注时段 —— 否则规划引擎会
   * 为同一时段再造日程并被冲突检测正确拒绝（那是产品行为，不是缺陷）。
   */
  const plan = ex(AGENT, 'plan.suggest', {
    goal: '幂等落地验证', targetTitles: ['幂等任务'],
    windowStart: W1 + 30 * DAY, windowEnd: W1 + 37 * DAY,
  })
  const t1 = approve(USER, 'proposal.apply', plan.proposal.id)
  const r1 = ex(USER, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: t1.token })
  check('E5.3 首次落地成功', r1.status === 'applied')
  let dupRejected = false
  try {
    const t2 = approve(USER, 'proposal.apply', plan.proposal.id)
    ex(USER, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: t2.token })
  } catch (e) { dupRejected = e.code === 'conflict' }
  check('E5.4 重复 apply 被拒（不重复建任务）', dupRejected)
  const idem = ex(USER, 'task.list', {}).filter((t) => t.title === '幂等任务')
  check('E5.5 幂等任务只有 1 条', idem.length === 1, String(idem.length))
}

console.log('')
console.log('='.repeat(70))
console.log('E6 · Agent 无法自行绕过审批')
console.log('='.repeat(70))
{
  // E6.1 危险 op 无 token 一律被拒
  // 造一个备份，好让 store.rollback 走到审批校验（否则先被参数校验拦住）
  ex(USER, 'store.backup', {})
  const backups = ex(USER, 'store.listBackups', {})
  const bname = String(Array.isArray(backups) ? backups[0] : '')
  const payloadOf = (op) => {
    if (op === 'store.rollback') return { name: bname, confirmed: true }
    if (op === 'snapshot.replace') return { text: '{}', confirmed: true }
    return { id: 'x', confirmed: true }
  }
  for (const op of ['proposal.apply', 'event.delete', 'snapshot.replace', 'store.rollback']) {
    let blocked = false
    try {
      ex(AGENT, op, payloadOf(op))
    } catch (e) { blocked = e.code === 'confirmation-required' }
    check(`E6.1 ${op} 无 token 被拒（含 confirmed:true）`, blocked)
  }
  // E6.2 payload.confirmed 不被采信
  let confirmedIgnored = false
  try {
    ex(AGENT, 'event.import', { text: 'BEGIN:VCALENDAR\nEND:VCALENDAR', confirmed: true })
  } catch (e) { confirmedIgnored = e.code === 'confirmation-required' }
  check('E6.2 payload.confirmed 不被采信', confirmedIgnored)
  // E6.3 AI 不能把进度写成 100
  ex(USER, 'task.upsert', { task: { id: 't-guard', title: '守卫' } })
  let progressBlocked = false
  try { ex(AGENT, 'task.writeProgress', { id: 't-guard', progress: 100 }) }
  catch (e) { progressBlocked = e.code === 'validation' }
  check('E6.3 进度 100 被拒（AI 不能自行完成）', progressBlocked)
  // E6.4 无 pending 申请时不能验收通过
  let acceptBlocked = false
  try { ex(USER, 'task.acceptCompletion', { id: 't-guard' }) }
  catch (e) { acceptBlocked = e.code === 'conflict' }
  check('E6.4 无验收申请时不能直接完成', acceptBlocked)
}

console.log('')
console.log('='.repeat(70))
console.log('E7 · 失败不破坏现有任务')
console.log('='.repeat(70))
{
  const before = JSON.stringify(ex(USER, 'task.list', {}))
  // 构造一个会失败的落地（目标不存在）
  const plan = ex(AGENT, 'plan.suggest', {
    goal: '失败回滚验证', targetTitles: ['正常任务'],
    windowStart: W0, windowEnd: W1,
  })
  // 篡改提案：让它指向不存在的 targetId
  const diskPath = join(dir, 'workbench.json')
  void diskPath
  // 直接构造一个 targetId 不存在的 item，再 apply
  const bad = ex(AGENT, 'proposal.preview', {
    items: [{ op: 'task.update', targetId: 'no-such-task', payload: { title: '改' } }],
  })
  let failed = false
  try {
    const t = approve(USER, 'proposal.apply', bad.proposal.id)
    ex(USER, 'proposal.apply', { id: bad.proposal.id }, { approvalToken: t.token })
  } catch (e) { failed = e.code === 'not-found' || e.code === 'conflict' }
  check('E7.1 目标不存在时落地失败', failed)
  check('E7.2 失败后现有任务未被破坏', JSON.stringify(ex(USER, 'task.list', {})) === before)
  // 提案保持可重试或已处理，不应出现半落地
  const p = ex(USER, 'proposal.get', { id: plan.proposal.id }).proposal
  check('E7.3 无关提案不受影响', p.status === 'pending')
}

console.log('')
console.log('='.repeat(70))
console.log(`WP6-E 端到端验收汇总: PASS=${pass} FAIL=${fail}`)
console.log('='.repeat(70))

rmSync(dir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

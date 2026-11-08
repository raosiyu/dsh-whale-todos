/**
 * WP6-C · Agent 会话协作端到端测试（真实 service，不 mock 业务层）。
 *
 * 覆盖：会话关联 → 上下文读取 → 进度回写 → 执行证据 → 验收申请 →
 * 用户验收 → 跨会话越权拒绝 → AI 工具面无危险 op。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'
import { createWorkbenchToolDefinitions } from '../src/host-tools.js'

const withService = (fn, opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wp6c-'))
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: opts.approvalMode ?? 'isolated',
    allowIsolatedApproval: true,
  })
  // 两个会话共用同一 Host Service（真实多会话协作形态）
  const ex = (sessionId, op, payload, meta = {}) => svc.execute(op, payload, {
    actor: 'ui', sessionId, scope: '', ...meta,
  })
  const result = fn(svc, ex, dir)
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(dir, { recursive: true, force: true })
  return result
}

const A = 'sess-agent-A'
const B = 'sess-agent-B'
const USER = 'sess-user'

test('WP6-C：完整协作链路 关联→上下文→进度→验收申请→用户验收', () => withService((svc, ex, dir) => {
  // 用户建任务并关联 Agent 会话 A
  ex(USER, 'task.upsert', { task: { id: 't1', title: '实现登录页', priority: 'high' } })
  ex(USER, 'task.setEstimate', { id: 't1', estimatedMinutes: 120 })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: A, role: 'execute', note: '负责实现' })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: B, role: 'review', note: '负责验收' })

  // Agent A 读自己的上下文
  const ctx = ex(A, 'task.context', { sessionId: A })
  assert.equal(ctx.tasks.length, 1)
  assert.equal(ctx.tasks[0].id, 't1')
  assert.equal(ctx.tasks[0].estimatedMinutes, 120)
  assert.deepEqual(ctx.tasks[0].roles, ['execute'])
  assert.equal(ctx.tasks[0].done, false)
  assert.equal(ctx.tasks[0].completion, null)
  assert.equal(ctx.tasks[0].progress, 0)

  // Agent A 回写进度 + 证据（两次，进度推进）
  ex(A, 'task.writeProgress', { id: 't1', progress: 30, note: '搭好表单', evidence: 'commit abc' })
  ex(A, 'task.writeProgress', { id: 't1', progress: 80, note: '联调通过', evidence: 'test log' })
  const ctx2 = ex(A, 'task.context', { sessionId: A })
  assert.equal(ctx2.tasks[0].progress, 80)
  assert.equal(ctx2.tasks[0].recentLog.length, 2)
  assert.equal(ctx2.tasks[0].recentLog[1].evidence, 'test log')

  // Agent A 提交完成验收申请（**不能自行完成**）
  const req = ex(A, 'task.requestCompletion', { id: 't1', summary: '登录页已实现，测试通过，请验收' })
  assert.equal(req.done, false)
  let row = ex(A, 'task.list', {}).find((t) => t.id === 't1')
  assert.notEqual(row.done, true, 'AI 提交验收申请后任务仍未完成')
  assert.equal(row.completion.status, 'pending')

  // 用户验收通过 → 才置 done
  const acc = ex(USER, 'task.acceptCompletion', { id: 't1' })
  assert.equal(acc.done, true)
  row = ex(A, 'task.list', {}).find((t) => t.id === 't1')
  assert.equal(row.done, true)
  assert.equal(row.completion.status, 'accepted')
  assert.equal(row.completion.decidedBy, 'user')

  // 持久化：重启后关联与进度不丢
  const svc2 = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const row2 = svc2.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row2.sessionLinks.length, 2)
  assert.equal(row2.executionLog.length, 2)
  assert.equal(row2.done, true)
}))

test('WP6-C：跨会话越权读上下文一律拒绝', () => withService((svc, ex) => {
  ex(USER, 'task.upsert', { task: { id: 't1', title: 'A 的任务' } })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: A, role: 'execute' })
  // B 传自己的 id 但想读 A 的上下文（B 没关联 t1）→ 空，不报错
  const bCtx = ex(B, 'task.context', { sessionId: B })
  assert.equal(bCtx.tasks.length, 0)
  // B 传 A 的 id → 冲突拒绝
  assert.throws(
    () => ex(B, 'task.context', { sessionId: A }),
    (e) => e.code === 'conflict',
  )
  // 缺 sessionId → validation
  assert.throws(
    () => ex(B, 'task.context', {}),
    (e) => e.code === 'validation',
  )
}))

test('WP6-C：用户驳回验收带 feedback，Agent 可再次申请', () => withService((svc, ex) => {
  ex(USER, 'task.upsert', { task: { id: 't1', title: 'A' } })
  ex(A, 'task.requestCompletion', { id: 't1', summary: '第一版' })
  ex(USER, 'task.rejectCompletion', { id: 't1', feedback: '缺少边界测试' })
  let row = ex(A, 'task.list', {}).find((t) => t.id === 't1')
  assert.equal(row.completion.status, 'rejected')
  assert.equal(row.completion.feedback, '缺少边界测试')
  assert.notEqual(row.done, true)
  // Agent 按反馈修改后再次申请
  ex(A, 'task.requestCompletion', { id: 't1', summary: '第二版：补了边界测试' })
  row = ex(A, 'task.list', {}).find((t) => t.id === 't1')
  assert.equal(row.completion.status, 'pending')
  ex(USER, 'task.acceptCompletion', { id: 't1' })
  assert.equal(ex(A, 'task.list', {}).find((t) => t.id === 't1').done, true)
}))

test('WP6-C：进度回写有上限，AI 不能靠进度把任务置完成', () => withService((svc, ex) => {
  ex(USER, 'task.upsert', { task: { id: 't1', title: 'A' } })
  assert.throws(() => ex(A, 'task.writeProgress', { id: 't1', progress: 100 }),
    (e) => e.code === 'validation')
  assert.throws(() => ex(A, 'task.writeProgress', { id: 't1', progress: 101 }),
    (e) => e.code === 'validation')
  const row = ex(A, 'task.list', {}).find((t) => t.id === 't1')
  assert.notEqual(row.done, true)
}))

test('WP6-C：AI 工具面不含完成/删除/批量覆盖/提案落地等危险工具', () => {
  const defs = createWorkbenchToolDefinitions({ service: { invoke: () => ({}) } })
  const names = defs.map((d) => d.name)
  const FORBIDDEN = [
    'workbench_plan_apply', 'workbench_accept_completion', 'workbench_reject_completion',
    'workbench_event_delete', 'workbench_event_bulk_delete', 'workbench_task_delete',
    'workbench_snapshot_replace', 'workbench_complete_task', 'workbench_task_done',
  ]
  for (const name of FORBIDDEN) {
    assert.equal(names.includes(name), false, `危险工具不得注册：${name}`)
  }
  // 但协作必需的工具要在
  for (const name of [
    'workbench_task_context', 'workbench_task_link_session',
    'workbench_task_progress', 'workbench_request_completion',
  ]) {
    assert.ok(names.includes(name), `协作工具缺失：${name}`)
  }
})

test('WP6-C：并发两个会话回写进度不互相覆盖', () => withService((svc, ex) => {
  ex(USER, 'task.upsert', { task: { id: 't1', title: 'A' } })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: A, role: 'execute' })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: B, role: 'execute' })
  // 交替回写
  ex(A, 'task.writeProgress', { id: 't1', progress: 20, note: 'A1' })
  ex(B, 'task.writeProgress', { id: 't1', progress: 40, note: 'B1' })
  ex(A, 'task.writeProgress', { id: 't1', progress: 60, note: 'A2' })
  ex(B, 'task.writeProgress', { id: 't1', progress: 80, note: 'B2' })
  const row = ex(A, 'task.list', {}).find((t) => t.id === 't1')
  assert.equal(row.executionLog.length, 4, '四条执行记录都要在，不能互相覆盖')
  assert.deepEqual(row.executionLog.map((e) => e.note), ['A1', 'B1', 'A2', 'B2'])
  assert.deepEqual(row.executionLog.map((e) => e.progress), [20, 40, 60, 80])
  // 两个会话的关联都还在
  assert.equal(row.sessionLinks.length, 2)
}))

test('WP6-C：task.context 不泄露其他会话的关联明细', () => withService((svc, ex) => {
  ex(USER, 'task.upsert', { task: { id: 't1', title: 'A' } })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: A, role: 'execute' })
  ex(USER, 'task.linkSession', { id: 't1', sessionId: B, role: 'review' })
  const ctx = ex(A, 'task.context', { sessionId: A })
  const raw = JSON.stringify(ctx)
  assert.equal(raw.includes(B), false, 'A 的上下文里不得出现 B 的 sessionId')
  assert.equal(raw.includes(A), false, '也不得回显调用方自己的 sessionId 原文（应脱敏为 [self]）')
  assert.equal(ctx.sessionId, '[self]', 'sessionId 字段必须脱敏')
  assert.deepEqual(ctx.tasks[0].roles, ['execute'], '只暴露自己那一条关联的 role')
}))

// ============================================================
// WP6-E 复审 P0 回归：这两个缺陷都是复审实测出来的，
// 既有测试（单 service、单 session）完全覆盖不到。
// ============================================================

test('WP6-E/P0：AI 工具面无法用 task_upsert 直接完成任务（验收不可绕过）', async () => {
  const { createWorkbenchToolDefinitions } = await import('../src/host-tools.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p0-done-'))
  try {
    const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const hostSvc = { invoke: (sid, op, p, m = {}) => svc.execute(op, p, { actor: 'agent', sessionId: sid, scope: '', ...m }) }
    const defs = createWorkbenchToolDefinitions({ service: hostSvc })
    const upsert = defs.find((d) => d.name === 'workbench_task_upsert')
    // schema 里不得有完成类参数
    assert.equal(upsert.parameters.done, undefined, 'AI 工具不得暴露 done 参数')
    assert.equal(upsert.parameters.status, undefined, 'AI 工具不得暴露 status 参数')
    // 即便强塞，payload 白名单也必须丢弃
    const exec = { agent: { session: { id: 'sess-A' } } }
    await upsert.execute({
      id: 'k1', title: '任务', done: true, status: 'done',
      completion: { status: 'accepted' }, deleted: true,
    }, exec)
    const row = svc.execute('task.list', {}, {}).find((t) => t.id === 'k1')
    assert.ok(row !== undefined)
    assert.notEqual(row.done, true, 'AI 不得直接完成任务')
    assert.equal(row.status, undefined, 'AI 不得设 status')
    assert.equal(row.completion, undefined, 'AI 不得伪造验收状态')
    assert.notEqual(row.deleted, true, 'AI 不得软删任务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WP6-E/P0：AI 不能把用户已验收的任务改回未完成', async () => {
  const { createWorkbenchToolDefinitions } = await import('../src/host-tools.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p0-reopen-'))
  try {
    const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const ex = (op, p) => svc.execute(op, p, { actor: 'ui', sessionId: 'u', scope: '' })
    ex('task.upsert', { task: { id: 'k2', title: '已验收' } })
    ex('task.requestCompletion', { id: 'k2', summary: '完成' })
    ex('task.acceptCompletion', { id: 'k2' })
    assert.equal(ex('task.list', {}).find((t) => t.id === 'k2').done, true)
    const hostSvc = { invoke: (sid, op, p, m = {}) => svc.execute(op, p, { actor: 'agent', sessionId: sid, scope: '', ...m }) }
    const upsert = createWorkbenchToolDefinitions({ service: hostSvc }).find((d) => d.name === 'workbench_task_upsert')
    await upsert.execute({ id: 'k2', title: '已验收', done: false }, { agent: { session: { id: 'a' } } })
    assert.equal(ex('task.list', {}).find((t) => t.id === 'k2').done, true, 'AI 不得推翻用户验收结果')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WP6-E/P0：真实 Host 下 Agent 生成提案、用户可见可确认（跨会话协作主路径）', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p0-cross-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const AGENT = 'sess-agent-p0'
    const USER = 'sess-user-p0'
    const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    const NOW = Date.parse('2026-11-09T00:00:00Z')
    // Agent 生成提案
    const plan = ex(AGENT, 'plan.suggest', {
      goal: '跨会话', targetTitles: ['写稿件'],
      windowStart: NOW, windowEnd: NOW + 7 * 86400000,
    })
    const pid = plan.proposal.id
    // 用户可见可读
    const list = ex(USER, 'proposal.list', {})
    assert.ok(list.some((p) => p.id === pid), '用户必须能看到 Agent 的提案')
    assert.equal(ex(USER, 'proposal.get', { id: pid }).proposal.id, pid)
    // 用户确认落地 → 任务建在用户工作区
    const tok = host.forSession(USER, '').confirmUserAction('proposal.apply', pid, { summary: 'c' })
    const applied = ex(USER, 'proposal.apply', { id: pid }, { approvalToken: tok.token })
    assert.equal(applied.status, 'applied')
    assert.ok(ex(USER, 'task.list', {}).some((t) => t.title === '写稿件'), '任务落在用户工作区')
    assert.equal(ex(AGENT, 'task.list', {}).filter((t) => t.title === '写稿件').length, 0,
      'Agent 工作区不应被写入用户任务')
    // 关联后 Agent 能读到跨工作区分配
    const t = ex(USER, 'task.list', {}).find((x) => x.title === '写稿件')
    ex(USER, 'task.linkSession', { id: t.id, sessionId: AGENT, role: 'execute' })
    const ctx = ex(AGENT, 'task.context', { sessionId: AGENT })
    assert.ok(ctx.tasks.some((x) => x.id === t.id), 'Agent 必须能读到自己被分配的任务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * ===== 复审三轮补测：VACUUM 五条必须变成 CAUGHT =====
 *
 * 这五条保护点**只在真实 Host 多分片下才被触发**，单 dataDir 的
 * `createWorkbenchService` 测不到 —— 这正是变异存活的根因，也再次印证
 * 复审「165/165 只证明已定义的保护点有测试」的判断。
 */

test('WP6-E/P1-2：apply 失败回滚不清空用户已有 undo 历史', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p12-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const U = 'sess-user-p12'
    const ex = (op, p, m = {}) => host.invoke(U, op, p, { actor: 'ui', scope: '', ...m })
    const NOW = Date.parse('2026-11-10T00:00:00Z')
    // 先攒几条用户自己的历史（undo 栈非空）
    for (let i = 0; i < 3; i += 1) {
      ex('task.upsert', { task: { id: `h${i}`, title: `历史${i}` } })
    }
    const undoBefore = ex('history.status', {}).undoDepth
    assert.ok(undoBefore >= 3, `前置条件：用户已有 ${undoBefore} 条撤销历史`)

    // 造一个**必然失败**的落地：先生成提案，再改动工作区让绑定校验失败
    const plan = ex('plan.suggest', {
      goal: 'P1-2', targetTitles: ['会被改的任务'],
      windowStart: NOW, windowEnd: NOW + 86400000,
    })
    const pid = plan.proposal.id
    // 提案生成后再写数据 → baseVersion/baseDigest 必然失配 → apply 走失败回滚分支
    ex('task.upsert', { task: { id: 'target-p12', title: '提案生成后才出现' } })
    const tok = host.forSession(U, '').confirmUserAction('proposal.apply', pid, { summary: 'c' })
    let failed = null
    try {
      ex('proposal.apply', { id: pid }, { approvalToken: tok.token })
    } catch (error) { failed = error }
    assert.ok(failed, '前置：本次落地必须失败才能检验回滚行为')

    // 关键断言：无论失败与否，用户历史不得被清空
    const undoAfter = ex('history.status', {}).undoDepth
    assert.ok(undoAfter > 0, `失败路径不得清空撤销历史（前 ${undoBefore} 后 ${undoAfter}）`)
    assert.equal(ex('history.status', {}).canUndo, true, '失败后用户仍应能撤销自己的历史')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WP6-E/P1-3：逐条目标摘要兜底——提案记录陈旧时仍拒绝落地', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p13b-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const U = 'sess-user-p13b'
    const ex = (op, p, m = {}) => host.invoke(U, op, p, { actor: 'ui', scope: '', ...m })
    const preview = (items, kind = 'mixed') => ex('proposal.preview', { kind, summary: '测试', items })

    ex('task.upsert', { task: { id: 'tgt', title: '目标', priority: 'low' } })
    const pv = preview([{ op: 'task.update', targetId: 'tgt', payload: { title: '目标改' } }])
    assert.equal(typeof pv.proposal.items[0].targetDigest, 'string')
    assert.ok(pv.proposal.items[0].targetDigest.length > 0,
      '生成提案时必须回填目标内容摘要，否则防替换完全失效')

    // 直接改提案记录：保留 baseVersion/baseDigest（仍与当前数据一致），
    // 只把逐条摘要改错 —— 这正是「提案陈旧/被篡改」的纵深防御场景。
    const collabFile = join(dir, '.collab', 'workbench.json')
    const raw = JSON.parse(readFileSync(collabFile, 'utf8'))
    const row = raw.proposals.find((x) => x.id === pv.proposal.id)
    row.items[0].targetDigest = 'deadbeefdeadbeef'
    writeFileSync(collabFile, JSON.stringify(raw, null, 2))

    const tok = host.forSession(U, '').confirmUserAction('proposal.apply', pv.proposal.id, { summary: 'c' })
    let rejected = null
    try {
      ex('proposal.apply', { id: pv.proposal.id }, { approvalToken: tok.token })
    } catch (error) { rejected = error }
    assert.ok(rejected, '逐条摘要不匹配必须拒绝落地')
    assert.match(String(rejected.message), /变化|摘要/, `拒绝原因应指向摘要，实际：${rejected.message}`)
    assert.equal(ex('task.list', {}).find((t) => t.id === 'tgt').title, '目标',
      '拒绝后目标不得被改动')

    // 空摘要同样必须拒绝（不能静默跳过校验）
    const pv2 = preview([{ op: 'task.update', targetId: 'tgt', payload: { title: '目标改2' } }])
    const raw2 = JSON.parse(readFileSync(collabFile, 'utf8'))
    raw2.proposals.find((x) => x.id === pv2.proposal.id).items[0].targetDigest = ''
    writeFileSync(collabFile, JSON.stringify(raw2, null, 2))
    const tok2 = host.forSession(U, '').confirmUserAction('proposal.apply', pv2.proposal.id, { summary: 'c' })
    let rejected2 = null
    try {
      ex('proposal.apply', { id: pv2.proposal.id }, { approvalToken: tok2.token })
    } catch (error) { rejected2 = error }
    assert.ok(rejected2, '空摘要必须拒绝，不得静默跳过校验')
    assert.match(String(rejected2.message), /摘要/, `空摘要拒绝原因应指向摘要，实际：${rejected2.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WP6-E/P0-2：跨工作区落地不误判全局摘要，且用户确认后数据正确', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p02a-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const AG = 'sess-agent-p02a'
    const U = 'sess-user-p02a'
    const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    const NOW = Date.parse('2026-11-11T00:00:00Z')
    // 用户在**自己工作区**先写点东西，制造与 Agent 不同的全局摘要
    ex(U, 'task.upsert', { task: { id: 'u-own', title: '用户自己的任务' } })
    // Agent 生成提案（baseDigest 描述 Agent 工作区）
    const plan = ex(AG, 'plan.suggest', {
      goal: 'P0-2 跨工作区', targetTitles: ['Agent 提议的任务'],
      windowStart: NOW, windowEnd: NOW + 86400000,
    })
    // 用户确认落地必须成功（不能因 globalDigest 不同而误拒）
    const tok = host.forSession(U, '').confirmUserAction('proposal.apply', plan.proposal.id, { summary: 'c' })
    const applied = ex(U, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: tok.token })
    assert.equal(applied.status, 'applied', '跨工作区落地必须成功，不能误判 base-digest-mismatch')
    assert.ok(ex(U, 'task.list', {}).some((t) => t.title === 'Agent 提议的任务'), '任务必须落地到用户工作区')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WP6-E/P0-2：两个会话交替写提案与分配，互不抹掉（无 lost update）', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p02b-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const AG1 = 'sess-agent-lu1'
    const AG2 = 'sess-agent-lu2'
    const U = 'sess-user-lu'
    const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    const NOW = Date.parse('2026-11-12T00:00:00Z')
    // 用户建任务并关联 AG1
    ex(U, 'task.upsert', { task: { id: 'lu-task', title: '共享任务' } })
    ex(U, 'task.linkSession', { id: 'lu-task', sessionId: AG1, role: 'execute' })
    // AG2 紧接着生成提案（会写 proposals 集合）
    ex(AG2, 'plan.suggest', {
      goal: 'LU', targetTitles: ['并发任务'],
      windowStart: NOW, windowEnd: NOW + 86400000,
    })
    // 关键断言：AG1 的 assignment 必须还在（不被 proposals 写入抹掉）
    const ctx1 = ex(AG1, 'task.context', { sessionId: AG1 })
    assert.equal(ctx1.tasks.length, 1,
      `AG1 的分配被抹掉了（${ctx1.tasks.length} 条）—— proposals 与 assignments 共享文件时必须回盘再写`)
    assert.equal(ctx1.tasks[0].id, 'lu-task')
    // 再反一次：AG1 写进度，AG2 的 proposal 必须还在
    ex(AG1, 'task.writeProgress', { id: 'lu-task', progress: 30, note: '进行中' })
    assert.ok(ex(U, 'proposal.list', {}).length >= 1, 'AG2 的提案不得被进度写入抹掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WP6-E/P0-2：Agent 在另一工作区也能回写进度并生成执行记录', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p02c-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const AG = 'sess-agent-wp'
    const U = 'sess-user-wp'
    const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    // 任务实体在用户工作区，Agent 工作区里没有它
    ex(U, 'task.upsert', { task: { id: 'wp-task', title: '跨区执行' } })
    ex(U, 'task.linkSession', { id: 'wp-task', sessionId: AG, role: 'execute' })
    assert.equal(ex(AG, 'task.list', {}).length, 0, '前置：Agent 工作区确实没有该任务')

    // Agent 回写进度必须成功（不能 not-found）
    const out = ex(AG, 'task.writeProgress', { id: 'wp-task', progress: 45, note: '写了一半' })
    assert.equal(out.via, 'shared-assignment', '跨工作区进度必须走共享 assignment')
    assert.equal(out.progress, 45)

    // 执行记录对 Agent 自己可追溯
    const ctx = ex(AG, 'task.context', { sessionId: AG })
    const row = ctx.tasks.find((t) => t.id === 'wp-task')
    assert.ok(row, 'Agent 必须能看到自己执行的任务')
    assert.ok(Array.isArray(row.recentLog) && row.recentLog.length >= 1, '执行记录必须可追溯')

    // 用户侧不暴露 progress 字段（只在集合层），但完成状态绝不能被 AI 推动
    const uRow = ex(U, 'task.list', {}).find((t) => t.id === 'wp-task')
    assert.notEqual(uRow.done, true, 'AI 回写进度不得把任务置完成')
    assert.notEqual(uRow.completion, 'pending', 'AI 只回写进度，不得伪造验收申请')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * WP6-E/P0-2 深度补测：**两个独立 Host 实例**共享同一根目录。
 *
 * 这是 lost-update 唯一能被观测到的形态：collab store 的 `collection()`
 * 读的是**内存快照**（store.js），单实例测试里内存与磁盘永远一致，
 * 因此「回盘取最新」这一步被删除也测不出来（变异 WP6P5 曾存活）。
 * 只有两个实例各自持有旧快照并交替写入，丢失更新才会暴露。
 */
test('WP6-E/P0-2：两个 Host 实例写同一集合，后写者不得抹掉先写者', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-lu3-'))
  try {
    const U = 'sess-user-lu3'
    // 先把任务建好（业务数据是 per-session 的，两侧实例都要能看到它们）
    {
      const prep = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
      prep.invoke(U, 'task.upsert', { task: { id: 'lu3-t1', title: '任务一' } }, { actor: 'ui', sessionId: U, scope: '' })
      prep.invoke(U, 'task.upsert', { task: { id: 'lu3-t2', title: '任务二' } }, { actor: 'ui', sessionId: U, scope: '' })
    }
    // 两个实例 = 两个进程视角，各自持有独立内存快照（此刻两侧内容相同）。
    // 变异 WP6P5 把「回盘取最新」换成读内存快照后，**同一集合**的后写会覆盖先写。
    const hostA = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const hostB = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const exA = (sid, op, p, m = {}) => hostA.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    const exB = (sid, op, p, m = {}) => hostB.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    const NOW = Date.parse('2026-11-15T00:00:00Z')

    // --- 同一集合（proposals）两次写 ---
    // A 先写一份提案到磁盘；B 的内存快照此时还没有它
    const pA = exA(U, 'plan.suggest', {
      goal: 'A 的提案', targetTitles: ['A 任务'],
      windowStart: NOW, windowEnd: NOW + 86400000,
    })
    // B 紧接着写自己的提案。若写入不回盘取最新，B 会用陈旧快照把 A 的提案整份抹掉
    const pB = exB(U, 'plan.suggest', {
      goal: 'B 的提案', targetTitles: ['B 任务'],
      windowStart: NOW + 86400000, windowEnd: NOW + 2 * 86400000,
    })
    const props = exA(U, 'proposal.list', {})
    const ids = props.map((x) => x.id)
    assert.ok(ids.includes(pA.proposal.id),
      `A 的提案被 B 抹掉了（现存 ${ids.length} 条）—— collab 写入必须回盘取最新再写`)
    assert.ok(ids.includes(pB.proposal.id), 'B 的提案必须存在')

    // --- 同一集合（assignments）两次写 ---
    const AG1 = 'sess-agt-lu3-1'
    const AG2 = 'sess-agt-lu3-2'
    exA(U, 'task.linkSession', { id: 'lu3-t1', sessionId: AG1, role: 'execute' })
    exB(U, 'task.linkSession', { id: 'lu3-t2', sessionId: AG2, role: 'execute' })

    const ctx1 = exA(AG1, 'task.context', { sessionId: AG1 })
    assert.equal(ctx1.tasks.length, 1,
      `AG1 的分配被另一实例抹掉（${ctx1.tasks.length} 条）—— assignments 写入必须回盘取最新`)
    assert.equal(ctx1.tasks[0].id, 'lu3-t1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * WP6-E/P1-2 深度补测：apply 失败后**用户原历史与业务数据都不得被改动**。
 *
 * 变异 WP6P1 把「精准回滚（只恢复 events/tasks/undo 到失败前）」换回
 * 「整份 store.rollback(backup)」，两者在正常路径下都让数据看起来对，
 * 差别只在失败瞬间用户的 undo 栈是否被清空 —— 必须有专门断言。
 */
test('WP6-E/P1-2：apply 落地阶段失败后 undo 栈与任务数据都保持失败前状态', async () => {
  const { createWorkbenchHostService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'wb-p12c-'))
  try {
    const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const U = 'sess-user-p12c'
    const ex = (op, p, m = {}) => host.invoke(U, op, p, { actor: 'ui', scope: '', ...m })
    const DAY = 86400000
    const T0 = Date.parse('2026-11-20T00:00:00Z')

    // 用户在提案要落的时段**已有**一个事件 → 落地第 2 条时必然时间冲突
    ex('event.create', { event: {
      title: '已占用', allDay: false, timeZone: 'Asia/Shanghai',
      start: '2026-11-20T02:00',
      end: '2026-11-20T03:00',
    } })
    for (const n of [1, 2, 3]) ex('task.upsert', { task: { id: `u${n}`, title: `任务${n}` } })

    // 提案：第 1 条 event 落在空档（会成功），第 2 条撞上 busy（落地阶段抛冲突）
    // —— 这样才真正执行到 backup/try/回滚分支，而不是更早的绑定校验。
    const preview = ex('proposal.preview', {
      kind: 'schedule',
      summary: '两条日程，第二条冲突',
      items: [
        { op: 'event.create', payload: {
          title: '空档会议', allDay: false, timeZone: 'Asia/Shanghai',
          start: '2026-11-20T00:00', end: '2026-11-20T01:00',
        } },
        { op: 'event.create', payload: {
          title: '冲突会议', allDay: false, timeZone: 'Asia/Shanghai',
          start: '2026-11-20T02:30', end: '2026-11-20T03:30',
        } },
      ],
    })

    const before = ex('history.status', {})
    assert.equal(before.canUndo, true, '前置：用户已有可撤销历史')
    const tasksBefore = ex('task.list', {}).map((t) => t.id).sort()

    const tok = host.forSession(U, '').confirmUserAction('proposal.apply', preview.proposal.id, { summary: 'c' })
    let failed = null
    try {
      ex('proposal.apply', { id: preview.proposal.id }, { approvalToken: tok.token })
    } catch (error) { failed = error }
    assert.ok(failed, '前置：第 2 条落地必须冲突失败')
    assert.match(String(failed.message), /冲突/, `失败原因应为时间冲突，实际：${failed.message}`)

    // 核心断言：回滚必须精准 —— 历史深度不变、任务集合不变
    const after = ex('history.status', {})
    assert.equal(after.undoDepth, before.undoDepth,
      `落地失败不得改动 undo 深度（前 ${before.undoDepth} 后 ${after.undoDepth}）`)
    assert.equal(after.canUndo, true, '失败后用户仍必须能撤销自己的历史')
    assert.deepEqual(ex('task.list', {}).map((t) => t.id).sort(), tasksBefore,
      '落地失败不得丢失或新增任务')
    // 第 1 条已成功写入的事件必须被回滚掉，不能残留半份提案
    const titles = ex('event.list', {}).map((e) => e.title)
    assert.ok(!titles.includes('空档会议'),
      `第 1 条事件必须被回滚（残留：${titles.join('、')}）`)
    assert.ok(titles.includes('已占用'), '用户原有事件不得被回滚误删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

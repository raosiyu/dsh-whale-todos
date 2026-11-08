/**
 * WP6-C · Agent 会话协作端到端测试（真实 service，不 mock 业务层）。
 *
 * 覆盖：会话关联 → 上下文读取 → 进度回写 → 执行证据 → 验收申请 →
 * 用户验收 → 跨会话越权拒绝 → AI 工具面无危险 op。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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

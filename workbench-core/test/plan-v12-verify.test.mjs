/**
 * V1.2 · AI 规划全链路的关键不变量。
 *
 * 已有 planning-wp6 / proposal-wp6 覆盖了细粒度行为，这里只锁三条
 * **产品级**承诺（够用即止，不重复造测试）：
 *   1. 用户确认前绝不改真实数据
 *   2. 拒绝提案不留残渣
 *   3. 确认后落地：任务有截止时间且带时区，审批 token 不可绕过
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchHostService } from '../src/index.js'

const withHost = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-plan-v12-'))
  const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const U = 'sess-plan-v12'
  const ex = (op, p, m = {}) => host.invoke(U, op, p, { actor: 'ui', scope: '', ...m })
  const approve = (op, target) => host.forSession(U, '').confirmUserAction(op, target, { summary: 'confirm' })
  try {
    return fn({ host, ex, approve, U })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const W0 = new Date('2026-11-09T00:00:00.000Z').getTime()
const week = () => ({ windowStart: W0, windowEnd: W0 + 7 * 86400000 })

test('V1.2 规划：确认前不写任何真实数据', () => withHost(({ ex }) => {
  const before = { e: ex('event.list', {}).length, t: ex('task.list', {}).length }
  const s = ex('plan.suggest', { goal: '准备产品评审', targetTitles: ['整理文档'], ...week() })
  assert.ok((s?.proposal ?? s)?.items?.length > 0, '必须生成提案条目')
  assert.equal(ex('event.list', {}).length, before.e, '确认前不得创建事件')
  assert.equal(ex('task.list', {}).length, before.t, '确认前不得创建任务')
}))

test('V1.2 规划：拒绝提案不留残渣', () => withHost(({ ex }) => {
  const before = { e: ex('event.list', {}).length, t: ex('task.list', {}).length }
  const s = ex('plan.suggest', { goal: '准备产品评审', targetTitles: ['整理文档'], ...week() })
  const p = s?.proposal ?? s
  ex('proposal.reject', { id: p.id })
  assert.equal(ex('event.list', {}).length, before.e, '拒绝后不得留事件')
  assert.equal(ex('task.list', {}).length, before.t, '拒绝后不得留任务')
}))

test('V1.2 规划：无审批 token 不能 apply', () => withHost(({ ex }) => {
  const s = ex('plan.suggest', { goal: '准备产品评审', targetTitles: ['整理文档'], ...week() })
  const p = s?.proposal ?? s
  assert.throws(() => ex('proposal.apply', { id: p.id }), /审批|token|confirm/i,
    '没有审批 token 时 apply 必须被拒')
  assert.equal(ex('task.list', {}).length, 0, '被拒后不得落地任何任务')
}))

test('V1.2 规划：确认后落地，任务截止时间带时区', () => withHost(({ ex, approve, U }) => {
  const s = ex('plan.suggest', { goal: '准备产品评审', targetTitles: ['整理需求文档', '约设计师'], ...week() })
  const p = s?.proposal ?? s
  const tok = approve('proposal.apply', p.id)
  ex('proposal.apply', { id: p.id }, { approvalToken: tok.token })

  const tasks = ex('task.list', {})
  assert.ok(tasks.length >= 2, `提案任务必须落地（实际 ${tasks.length}）`)
  for (const t of tasks) {
    assert.ok(typeof t.dueAt === 'string' && t.dueAt !== '', `任务「${t.title}」必须有截止时间`)
    assert.match(t.dueAt, /(?:Z|[+-]\d{2}:\d{2})$/, '截止时间必须带时区偏移')
  }
}))

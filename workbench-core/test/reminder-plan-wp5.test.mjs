/**
 * WP5：提醒（reminder.plan）。
 *
 * 硬约束：
 * - 只读：不改数据、不需要审批、不进 WRITE_OPS。
 * - 算不出（skipped）必须原样上抛，不许把「算不出」伪装成「没有」。
 * - 已过期的不补建（compileReminder 返回 null 即丢弃）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService, WRITE_OPS, DANGEROUS_OPS } from '../src/index.js'

const DAY = 86400000

function withService(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-reminder-'))
  try {
    return fn(createWorkbenchService({ dataDir: dir, approvalMode: 'host', ...opts }), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reminder.plan 是只读操作：不进 WRITE_OPS / DANGEROUS_OPS', () => {
  assert.equal(WRITE_OPS.includes('reminder.plan'), false, '只读操作不得进 WRITE_OPS')
  assert.equal(DANGEROUS_OPS.includes('reminder.plan'), false, '只读操作不得进 DANGEROUS_OPS')
})

test('reminder.plan 在 deny 模式下仍可用（只读不该被写闸拦住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-reminder-deny-'))
  try {
    const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'deny' })
    const plan = svc.execute('reminder.plan', { nowMs: Date.parse('2026-11-06T00:00:00Z') }, {})
    assert.equal(Array.isArray(plan.plans), true, 'deny 模式下只读提醒仍然算得出来')
    assert.deepEqual(plan.plans, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reminder.plan 真的把到点的待办算成提醒，且提前量生效', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  const dueMs = nowMs + 2 * DAY
  svc.execute('task.upsert', {
    task: { id: 'r1', title: '写交付报告', dueAt: new Date(dueMs).toISOString(), priority: 'high' },
  }, { actor: 'ui' })

  const plan = svc.execute('reminder.plan', { nowMs, leadMinutes: 15, windowDays: 7 }, {})
  assert.equal(plan.plans.length, 1, '一条到期待办应产出一条提醒')
  const p = plan.plans[0]
  assert.equal(p.fireAtMs, dueMs - 15 * 60000, '触发时刻 = 到期时刻 - 提前量')
  assert.match(p.title, /写交付报告/)
  assert.match(p.prompt, /到期/)
  assert.equal(plan.skipped.length, 0)
}))

test('reminder.plan 已完成 / 无 dueAt 的待办不产出提醒', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  const dueMs = nowMs + 2 * DAY
  svc.execute('task.upsert', {
    task: { id: 'a', title: '已完成', dueAt: new Date(dueMs).toISOString(), done: true },
  }, { actor: 'ui' })
  svc.execute('task.upsert', { task: { id: 'b', title: '没定时间' } }, { actor: 'ui' })

  const plan = svc.execute('reminder.plan', { nowMs }, {})
  assert.deepEqual(plan.plans, [], '已完成与无截止时间的都不提醒')
}))

test('reminder.plan 已过期的提醒不补建（不轰炸历史提醒）', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  const pastMs = nowMs - 3 * DAY
  svc.execute('task.upsert', {
    task: { id: 'p', title: '早该做', dueAt: new Date(pastMs).toISOString() },
  }, { actor: 'ui' })

  const plan = svc.execute('reminder.plan', { nowMs, leadMinutes: 15 }, {})
  assert.deepEqual(plan.plans, [], '过期的不补建')
}))

test('空 dueAt 是「没填」不是「填错」：不提醒也不报警（假警报回归）', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  // 界面新建待办时 dueAt 就是空串 —— 这是正常状态，不是坏数据。
  // 曾经把空串当成 invalid-dueAt 上报，用户新建一条待办就被告知「数据有问题」。
  for (const blank of ['', '   ', null, undefined]) {
    svc.execute('task.upsert', {
      task: { id: `blank-${String(blank)}`, title: '没填截止时间', dueAt: blank },
    }, { actor: 'ui' })
  }
  const plan = svc.execute('reminder.plan', { nowMs }, {})
  assert.deepEqual(plan.plans, [], '没填截止时间就不产出提醒')
  assert.deepEqual(plan.skipped, [], '没填 ≠ 填错，不得对正常操作报假警')
}))

test('reminder.plan 的 skipped 必须上抛，不许把「算不出」伪装成「没有」', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  // dueAt 无法解析 → 算不出，必须出现在 skipped 里
  svc.execute('task.upsert', {
    task: { id: 'bad', title: '坏数据', dueAt: 'not-a-date' },
  }, { actor: 'ui' })

  const plan = svc.execute('reminder.plan', { nowMs }, {})
  assert.deepEqual(plan.plans, [], '算不出就不产出')
  assert.equal(plan.skipped.length, 1, '但必须显式上报 skipped')
  assert.equal(plan.skipped[0].taskId, 'bad')
  assert.equal(plan.skipped[0].reason, 'invalid-dueAt')
}))

test('reminder.plan 结果按触发时刻升序（UI 直接顺序渲染即可）', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  svc.execute('task.upsert', {
    task: { id: 'late', title: '晚', dueAt: new Date(nowMs + 3 * DAY).toISOString() },
  }, { actor: 'ui' })
  svc.execute('task.upsert', {
    task: { id: 'early', title: '早', dueAt: new Date(nowMs + 1 * DAY).toISOString() },
  }, { actor: 'ui' })

  const plan = svc.execute('reminder.plan', { nowMs }, {})
  assert.deepEqual(plan.plans.map((p) => p.title), ['早', '晚'], '按触发时刻升序')
}))

test('reminder.plan 拒绝非法 leadMinutes', () => withService((svc) => {
  const nowMs = Date.parse('2026-11-06T00:00:00Z')
  // null / undefined 表示「未指定」，按默认提前量处理（合法，不算非法值）
  for (const bad of [-1, 1.5, '15', true]) {
    assert.throws(
      () => svc.execute('reminder.plan', { nowMs, leadMinutes: bad }, {}),
      (e) => e?.code === 'validation',
      `leadMinutes=${JSON.stringify(bad)} 必须被拒`,
    )
  }
  // 未指定时回落到默认提前量，而不是报错
  const plan = svc.execute('reminder.plan', { nowMs, leadMinutes: null }, {})
  assert.equal(plan.leadMinutes, 15, 'null 视为未指定，用默认 15 分钟')
}))

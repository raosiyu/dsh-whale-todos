/**
 * WP6-A · 提案与会话协作 op 的真实行为测试。
 *
 * 用真实 `createWorkbenchService`（真 store / 真审批门）驱动，不 mock 业务层。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService, WRITE_OPS, DANGEROUS_OPS } from '../src/index.js'

const withService = (fn, opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wp6-'))
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: opts.approvalMode ?? 'isolated',
    allowIsolatedApproval: true,
  })
  const result = fn(svc, dir, (op, payload, meta = {}) => svc.execute(op, payload, {
    actor: 'ui', sessionId: 'sess-A', scope: '', ...meta,
  }))
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(dir, { recursive: true, force: true })
  return result
}

const call = (svc, op, payload, meta = {}) => svc.execute(op, payload, {
  actor: 'ui', sessionId: 'sess-A', scope: '', ...meta,
})

const mkItem = (op = 'task.create', payload = { title: '买牛奶', priority: 'normal' }) => ({ op, payload })

// ---------------------------------------------------------------- 提案生成

test('WP6-A：proposal.preview 只建 pending 提案，不改 events/tasks', () => withService((svc, dir, ex) => {
  const before = svc.execute('task.list', {}, {})
  const r = ex('proposal.preview', {
    sourceText: '帮我安排这周的工作',
    reasoning: '按优先级拆分',
    items: [mkItem(), mkItem('task.create', { title: '写周报' })],
  })
  assert.equal(r.proposal.status, 'pending')
  assert.equal(r.proposal.sessionId, 'sess-A')
  assert.ok(r.proposal.baseDigest.length > 0)
  assert.equal(r.proposal.items.length, 2)
  // 业务数据零变化
  assert.deepEqual(svc.execute('task.list', {}, {}), before)
  // 提案已持久化（重启可读）
  const raw = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'))
  assert.equal(raw.proposals.length, 1)
  assert.equal(raw.proposals[0].id, r.proposal.id)
}))

test('WP6-A：AI 文本被净化，payload 里的危险字段被裁剪掉', () => withService((svc, dir, ex) => {
  const r = ex('proposal.preview', {
    sourceText: 'x'.repeat(5000),
    items: [mkItem('task.create', {
      title: 'A', confirmed: true, approvalToken: 'fake', deleted: true,
      id: 'hacker-id', estimatedMinutes: 45,
    })],
  })
  const item = r.proposal.items[0]
  assert.equal(item.payload.confirmed, undefined, 'confirmed 必须被丢弃')
  assert.equal(item.payload.approvalToken, undefined)
  assert.equal(item.payload.deleted, undefined)
  assert.equal(item.payload.id, undefined, 'id 不能被 AI 指定')
  assert.equal(item.payload.estimatedMinutes, 45)
  assert.ok(r.proposal.sourceText.length <= 2000, '不可信文本要截断')
  void svc
}))

test('WP6-A：非法 op / 缺 title / 空 items 一律拒绝', () => withService((svc, dir, ex) => {
  assert.throws(() => ex('proposal.preview', { items: [] }), (e) => e.code === 'validation')
  assert.throws(() => ex('proposal.preview', {
    items: [mkItem('event.delete', {})],
  }), (e) => e.code === 'validation')
  assert.throws(() => ex('proposal.preview', {
    items: [mkItem('task.create', { title: '' })],
  }), (e) => e.code === 'validation')
  void svc
}))

test('WP6-A：task.update 必须绑定 targetId', () => withService((svc, dir, ex) => {
  assert.throws(() => ex('proposal.preview', {
    items: [{ op: 'task.update', payload: { title: '改' } }],
  }), /targetId/)
  void svc
}))

// ---------------------------------------------------------------- 提案列表/拒绝

test('WP6-A：proposal.list/get 按 session+scope 隔离', () => withService((svc) => {
  call(svc, 'proposal.preview', { items: [mkItem()] })
  const list = call(svc, 'proposal.list', {})
  assert.equal(list.length, 1)
  // 别的 session 看不到
  const other = svc.execute('proposal.list', {}, { actor: 'ui', sessionId: 'sess-B', scope: '' })
  assert.equal(other.length, 0)
  // 别的 scope 看不到
  const otherScope = call(svc, 'proposal.list', {}, { scope: 'projX' })
  assert.equal(otherScope.length, 0)
  assert.throws(() => svc.execute('proposal.get', { id: list[0].id }, {
    actor: 'ui', sessionId: 'sess-B', scope: '',
  }), /not-found|提案不存在/)
}))

test('WP6-A：用户拒绝提案时 events/tasks 零变化，状态变 rejected', () => withService((svc, dir, ex) => {
  const { proposal } = ex('proposal.preview', { items: [mkItem()] })
  const beforeTasks = svc.execute('task.list', {}, {})
  const r = ex('proposal.reject', { id: proposal.id })
  assert.equal(r.status, 'rejected')
  assert.deepEqual(svc.execute('task.list', {}, {}), beforeTasks)
  assert.throws(() => ex('proposal.reject', { id: proposal.id }), /已处理|conflict/)
}))

// ---------------------------------------------------------------- 提案落地

test('WP6-A：proposal.apply 无 token 被拒（审批红线）', () => withService((svc, dir, ex) => {
  const { proposal } = ex('proposal.preview', { items: [mkItem()] })
  assert.throws(() => ex('proposal.apply', { id: proposal.id }), (e) => e.code === 'confirmation-required')
  assert.deepEqual(svc.execute('task.list', {}, {}), [])
}))

test('WP6-A：proposal.apply 带真 token 落地，一次 undo 可整体撤销', () => withService(async (svc, dir, ex) => {
  const { proposal } = ex('proposal.preview', {
    items: [
      mkItem('task.create', { title: '任务甲' }),
      mkItem('task.create', { title: '任务乙' }),
    ],
  })
  const token = await svc.requestApproval('proposal.apply', { target: proposal.id })
  const r = ex('proposal.apply', { id: proposal.id }, { approvalToken: token.token })
  assert.equal(r.status, 'applied')
  assert.equal(r.created, 2)
  assert.equal(svc.execute('task.list', {}, {}).length, 2)

  // 折叠成一条 undo：一次撤销清空两条
  const st = svc.execute('history.status', {}, {})
  assert.ok(st.canUndo)
  ex('history.undo', {})
  assert.equal(svc.execute('task.list', {}, {}).length, 0, '一次 undo 应整体撤销')
}))

test('WP6-A：确认后数据被改过 → 整份拒绝，不部分落地', () => withService(async (svc, dir, ex) => {
  const { proposal } = ex('proposal.preview', { items: [mkItem()] })
  // 生成提案后，用别的路径改了数据 → 版本/摘要变化
  ex('task.upsert', { task: { id: 't-other', title: '别的改动' } })
  const token = await svc.requestApproval('proposal.apply', { target: proposal.id })
  assert.throws(
    () => ex('proposal.apply', { id: proposal.id }, { approvalToken: token.token }),
    /绑定校验失败|conflict/,
  )
  // 提案仍 pending，可重新生成
  assert.equal(call(svc, 'proposal.get', { id: proposal.id }).proposal.status, 'pending')
}))

test('WP6-A：跨 session 不能用别人的提案', () => withService(async (svc, dir, ex) => {
  const { proposal } = ex('proposal.preview', { items: [mkItem()] })
  const token = await svc.requestApproval('proposal.apply', { target: proposal.id })
  assert.throws(
    () => svc.execute('proposal.apply', { id: proposal.id }, {
      actor: 'ui', sessionId: 'sess-B', scope: '', approvalToken: token.token,
    }),
    /session-mismatch|绑定校验/,
  )
}))

test('WP6-A：落地失败整体回滚，不部分写入', () => withService(async (svc, dir, ex) => {
  const { proposal } = ex('proposal.preview', {
    items: [
      { op: 'task.update', targetId: 'missing-id', payload: { title: '改' } },
    ],
  })
  const token = await svc.requestApproval('proposal.apply', { target: proposal.id })
  assert.throws(
    () => ex('proposal.apply', { id: proposal.id }, { approvalToken: token.token }),
    /不存在|not-found/,
  )
  assert.deepEqual(svc.execute('task.list', {}, {}), [])
}))

// ---------------------------------------------------------------- 任务扩展字段

test('WP6-A：预计耗时严格校验，非法整份拒绝', () => withService((svc, dir, ex) => {
  ex('task.upsert', { task: { id: 't1', title: 'A' } })
  assert.equal(ex('task.setEstimate', { id: 't1', estimatedMinutes: 45 }).estimatedMinutes, 45)
  for (const bad of [0, 1441, 3.5, 'x', NaN]) {
    assert.throws(() => ex('task.setEstimate', { id: 't1', estimatedMinutes: bad }), (e) => e.code === 'validation')
  }
  // 校验失败后原值不变
  const row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.estimatedMinutes, 45)
}))

test('WP6-A：会话关联可添加/去重/反查/解除', () => withService((svc, dir, ex) => {
  ex('task.upsert', { task: { id: 't1', title: 'A' } })
  ex('task.linkSession', { id: 't1', sessionId: 'sess-X', role: 'execute', note: '执行会话' })
  ex('task.linkSession', { id: 't1', sessionId: 'sess-X', role: 'execute', note: '重复' })
  ex('task.linkSession', { id: 't1', sessionId: 'sess-Y', role: 'review' })
  let row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.sessionLinks.length, 2, '同 sessionId+role 去重')
  assert.equal(row.sessionLinks.find((l) => l.sessionId === 'sess-X').note, '重复')
  assert.equal(call(svc, 'task.bySession', { sessionId: 'sess-X' }).length, 1)
  assert.equal(call(svc, 'task.bySession', { sessionId: 'sess-none' }).length, 0)
  ex('task.unlinkSession', { id: 't1', sessionId: 'sess-X' })
  row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.sessionLinks.length, 1)
}))

test('WP6-A：会话关联持久化，重启后不丢', () => withService((svc, dir, ex) => {
  ex('task.upsert', { task: { id: 't1', title: 'A' } })
  ex('task.linkSession', { id: 't1', sessionId: 'sess-X', role: 'execute' })
  // 重新 open 同一目录
  const svc2 = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const row = svc2.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.sessionLinks[0].sessionId, 'sess-X')
}))

// ---------------------------------------------------------------- 进度与人工验收

test('WP6-A：进度上限 99，100 被拒（AI 不能自行完成）', () => withService((svc, dir, ex) => {
  ex('task.upsert', { task: { id: 't1', title: 'A' } })
  assert.equal(ex('task.writeProgress', { id: 't1', progress: 60, note: '过半' }).progress, 60)
  assert.throws(() => ex('task.writeProgress', { id: 't1', progress: 100 }), /0\.\.99/)
  assert.throws(() => ex('task.writeProgress', { id: 't1', progress: -1 }), /0\.\.99/)
  const row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.executionLog.length, 1)
  assert.notEqual(row.done, true, '回写进度绝不置 done')
}))

test('WP6-A：AI 提交验收申请不改 done；用户验收通过才 done', () => withService((svc, dir, ex) => {
  ex('task.upsert', { task: { id: 't1', title: 'A' } })
  const req = ex('task.requestCompletion', { id: 't1', summary: '已完成，请验收' })
  assert.equal(req.done, false)
  let row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.done, undefined)
  assert.equal(row.completion.status, 'pending')

  const acc = ex('task.acceptCompletion', { id: 't1' })
  assert.equal(acc.done, true)
  row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.equal(row.done, true)
  assert.equal(row.completion.status, 'accepted')
  assert.equal(row.completion.decidedBy, 'user')
  // 重复验收被拒
  assert.throws(() => ex('task.acceptCompletion', { id: 't1' }), /conflict|没有待验收/)
}))

test('WP6-A：用户驳回验收申请带 feedback，done 不变', () => withService((svc, dir, ex) => {
  ex('task.upsert', { task: { id: 't1', title: 'A' } })
  ex('task.requestCompletion', { id: 't1', summary: '请验收' })
  const r = ex('task.rejectCompletion', { id: 't1', feedback: '还差测试' })
  assert.equal(r.status, 'rejected')
  const row = svc.execute('task.list', {}, {}).find((t) => t.id === 't1')
  assert.notEqual(row.done, true)
  assert.equal(row.completion.feedback, '还差测试')
}))

// ---------------------------------------------------------------- 权限清单

test('WP6-A：新写 op 全部进 WRITE_OPS，proposal.apply 进 DANGEROUS_OPS', () => {
  const newWrites = [
    'proposal.preview', 'proposal.reject', 'proposal.apply',
    'task.setEstimate', 'task.linkSession', 'task.unlinkSession',
    'task.writeProgress', 'task.requestCompletion',
    'task.acceptCompletion', 'task.rejectCompletion',
  ]
  for (const op of newWrites) assert.ok(WRITE_OPS.includes(op), `${op} 必须在 WRITE_OPS`)
  assert.ok(DANGEROUS_OPS.includes('proposal.apply'))
  // 只读 op 不该进 WRITE_OPS
  assert.equal(WRITE_OPS.includes('proposal.list'), false)
  assert.equal(WRITE_OPS.includes('proposal.get'), false)
  assert.equal(WRITE_OPS.includes('task.bySession'), false)
})

test('WP6-A：deny 模式下所有新写 op 一律被拒', () => withService((svc) => {
  for (const op of [
    'proposal.preview', 'proposal.apply', 'task.setEstimate',
    'task.linkSession', 'task.writeProgress', 'task.requestCompletion',
    'task.acceptCompletion',
  ]) {
    assert.throws(
      () => svc.execute(op, { items: [mkItem()], id: 'x', estimatedMinutes: 30, progress: 50, summary: 'x' },
        { actor: 'ui', sessionId: 'sess-A', scope: '' }),
      (e) => e.code === 'confirmation-required',
      `deny 模式下 ${op} 必须被拒`,
    )
  }
}, { approvalMode: 'deny' }))

test('WP6-A：PROPOSAL_ALLOWED_OPS 绝不含任何危险/删除类 op（白名单锁）', async () => {
  const { PROPOSAL_ALLOWED_OPS } = await import('../src/proposal.js')
  const FORBIDDEN = [
    'event.delete', 'event.bulkDelete', 'event.import', 'snapshot.replace',
    'store.rollback', 'event.restore', 'task.upsert', 'proposal.apply',
    'task.acceptCompletion', 'task.rejectCompletion', 'history.undo',
  ]
  for (const op of FORBIDDEN) {
    assert.equal(PROPOSAL_ALLOWED_OPS.includes(op), false,
      `提案白名单不得包含 ${op}（否则 AI 可借提案绕过审批）`)
  }
  assert.deepEqual([...PROPOSAL_ALLOWED_OPS].sort(), ['event.create', 'task.create', 'task.update'])
})

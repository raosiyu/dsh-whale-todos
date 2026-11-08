import { createWorkbenchHostService } from '/Users/sylas/Developer/dsh-workbench/workbench-core/src/index.js'
import { createWorkbenchToolDefinitions } from '/Users/sylas/Developer/dsh-workbench/workbench-core/src/host-tools.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lead-cm2-'))
const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
const U = 'sess-u1', AG = 'sess-ag'
const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log('  PASS ' + l) } else { fail++; console.log('  FAIL ' + l + ' ' + e) } }

try {
  const hostSvc = { invoke: (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'agent', scope: '', ...m }) }
  const defs = createWorkbenchToolDefinitions({ service: hostSvc })
  const names = defs.map(d => d.name)
  console.log('  已注册工具数:', names.length)
  for (const bad of ['workbench_event_delete','workbench_snapshot_replace','workbench_store_rollback','workbench_proposal_apply'])
    ok(!names.includes(bad), `工具面不含 ${bad}`)

  const upsert = defs.find(d => d.name === 'workbench_task_upsert')
  ok(!('done' in upsert.parameters) && !('status' in upsert.parameters) && !('completion' in upsert.parameters),
     'upsert schema 无 done/status/completion')

  // AI 在自己的分片里强塞完成字段 —— 白名单必须丢弃
  const execAI = { agent: { session: { id: AG } } }
  await upsert.execute({ id: 'a1', title: 'AI建的任务', done: true, status: 'done', completion: { status: 'accepted' } }, execAI)
  const aiRow = ex(AG, 'task.list', {}).find(t => t.id === 'a1')
  ok(aiRow !== undefined && aiRow.done !== true, 'AI 强塞完成字段被白名单丢弃', JSON.stringify(aiRow?.done))

  // 完成语义全程在用户分片里走
  ex(U, 'task.upsert', { task: { id: 't1', title: '任务' } })
  ex(U, 'task.linkSession', { id: 't1', sessionId: AG, role: 'execute' })

  let r = null
  try { ex(AG, 'task.writeProgress', { id: 't1', progress: 100 }) } catch (e) { r = e }
  ok(!!r, 'writeProgress 传 100 被拒', r?.message)

  const req = ex(AG, 'task.requestCompletion', { id: 't1', summary: '做完了' })
  ok(req.done === false, 'requestCompletion 返回 done=false', String(req.done))
  let row = ex(U, 'task.list', {}).find(t => t.id === 't1')
  ok(row.done !== true, '申请后用户侧任务仍未完成', String(row.done))

  // 用户视角验收：用 task.list 读（task.context 是 Agent 侧按 assignment 过滤的视角，不能当用户视图）
  ex(U, 'task.acceptCompletion', { id: 't1' })
  const f = ex(U, 'task.list', {}).find(t => t.id === 't1')
  ok(f?.done === true, '用户验收后任务才 done', JSON.stringify({ done: f?.done }))
  ok(f?.completion?.status === 'accepted' && f?.completion?.decidedBy === 'user',
     '完成记录标记为用户验收', JSON.stringify({ status: f?.completion?.status, by: f?.completion?.decidedBy }))

  console.log('\n完成语义: PASS=' + pass + ' FAIL=' + fail)
} finally { rmSync(dir, { recursive: true, force: true }) }

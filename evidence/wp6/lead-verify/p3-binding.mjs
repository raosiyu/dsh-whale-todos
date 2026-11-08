import { createWorkbenchHostService } from '/Users/sylas/Developer/dsh-workbench/workbench-core/src/index.js'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lead-bd-'))
const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
const U = 'sess-u1'
const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
const tok = (sid, op, tgt) => host.forSession(sid, '').confirmUserAction(op, tgt, { summary: 'c' })
let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log('  PASS ' + l) } else { fail++; console.log('  FAIL ' + l + ' ' + e) } }
const collabFile = join(dir, '.collab', 'workbench.json')

try {
  // 1. 目标在提案生成后被改动 → 落地必须被拒
  ex(U, 'task.upsert', { task: { id: 'x1', title: '原题', priority: 'low' } })
  const p1 = ex(U, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.update', targetId: 'x1', payload: { title: '改后' } }] })
  ex(U, 'task.upsert', { task: { id: 'x1', title: '被抢改' } })
  let r = null
  try { ex(U, 'proposal.apply', { id: p1.proposal.id }, { approvalToken: tok(U, 'proposal.apply', p1.proposal.id).token }) } catch (e) { r = e }
  ok(!!r, '目标被改动后 apply 被拒', r?.message)
  ok(ex(U, 'task.list', {}).find(t => t.id === 'x1').title === '被抢改', '被拒后目标保持用户改动')

  // 2. 拒绝提案 → 数据完全不变
  const before = JSON.stringify(ex(U, 'task.list', {}))
  const p2 = ex(U, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.create', payload: { title: '不该出现' } }] })
  ex(U, 'proposal.reject', { id: p2.proposal.id, reason: '不要' })
  ok(JSON.stringify(ex(U, 'task.list', {})) === before, '拒绝后任务集完全不变')
  r = null
  try { ex(U, 'proposal.apply', { id: p2.proposal.id }, { approvalToken: tok(U, 'proposal.apply', p2.proposal.id).token }) } catch (e) { r = e }
  ok(!!r, '已拒绝的提案不能再 apply', r?.message)
  ok(!ex(U, 'task.list', {}).some(t => t.title === '不该出现'), '已拒绝提案的条目未落地')

  // 3. undo 只回退这一次，不连带更早操作
  const p3 = ex(U, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.create', payload: { title: '提案新增' } }] })
  ex(U, 'proposal.apply', { id: p3.proposal.id }, { approvalToken: tok(U, 'proposal.apply', p3.proposal.id).token })
  const hasNew = ex(U, 'task.list', {}).some(t => t.title === '提案新增')
  ok(hasNew, 'apply 后条目存在')
  const st = ex(U, 'history.status', {})
  ok(st.canUndo === true, 'history.status 显示可撤销')
  ex(U, 'history.undo', {})
  ok(!ex(U, 'task.list', {}).some(t => t.title === '提案新增'), 'undo 后提案条目消失')
  ok(ex(U, 'task.list', {}).some(t => t.id === 'x1'), 'undo 未连带删掉更早的用户任务')

  // 4. 空 targetDigest 硬拒绝
  const p4 = ex(U, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.update', targetId: 'x1', payload: { title: 'y' } }] })
  const j = JSON.parse(readFileSync(collabFile, 'utf8'))
  j.proposals.find(p => p.id === p4.proposal.id).items[0].targetDigest = ''
  writeFileSync(collabFile, JSON.stringify(j, null, 2))
  r = null
  try { ex(U, 'proposal.apply', { id: p4.proposal.id }, { approvalToken: tok(U, 'proposal.apply', p4.proposal.id).token }) } catch (e) { r = e }
  ok(!!r && /摘要/.test(String(r.message)), '空摘要被硬拒绝', r?.message)

  console.log('\n绑定/拒绝/undo: PASS=' + pass + ' FAIL=' + fail)
} finally { rmSync(dir, { recursive: true, force: true }) }

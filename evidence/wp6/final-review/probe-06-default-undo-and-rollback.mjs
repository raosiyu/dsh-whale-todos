/**
 * WP6 终审 · 探针 6：
 *  (A) 默认 historyLimit=20 + 真实规模提案（>20 条 item）时，「一次 undo 整体撤销」是否成立
 *  (B) proposal.apply 失败回滚是否会清空用户既有 undo 历史
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const core = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createWorkbenchService } = core

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const DAY = 86400000
const W0 = Date.parse('2026-11-09T00:00:00Z')
const W1 = W0 + 7 * DAY

console.log('='.repeat(72))
console.log('A · 默认 historyLimit=20，大提案（>20 条 item）的一次撤销')
console.log('='.repeat(72))
{
  const dir = mkdtempSync(join(tmpdir(), 'wp6-fr6a-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
  const U = 'session-u'; const A = 'session-a'

  // 先积累少量历史（真实用户总有几步操作）
  for (let i = 0; i < 3; i += 1) ex(U, 'task.upsert', { task: { id: `p${i}`, title: `既有 ${i}` } })
  const tasksBefore = ex(U, 'task.list', {}).length
  const depthBefore = ex(U, 'history.status', {}).undoDepth

  // 25 条任务的提案（用户一次规划一周 = 完全现实）
  const items = Array.from({ length: 25 }, (_, i) => ({ op: 'task.create', payload: { title: `规划任务 ${i}` } }))
  const p = ex(A, 'proposal.preview', { items }).proposal
  const tk = await svc.requestApproval('proposal.apply', { target: p.id })
  const applied = ex(U, 'proposal.apply', { id: p.id }, { approvalToken: tk.token })
  const tasksAfter = ex(U, 'task.list', {}).length
  const st = ex(U, 'history.status', {})
  console.log(`  落地 ${applied.created} 条；任务 ${tasksBefore} → ${tasksAfter}；undoDepth ${depthBefore} → ${st.undoDepth}；nextUndo=${String(st.nextUndo)}`)

  check('A1 落地 25 条应折叠为一条 undo', st.nextUndo === 'proposal.apply',
    `实际 nextUndo=${String(st.nextUndo)}（undoDepth=${st.undoDepth}）`)
  ex(U, 'history.undo', {})
  const afterOne = ex(U, 'task.list', {}).length
  check('A2 一次撤销回到落地前（契约 §4 B 验收项）', afterOne === tasksBefore,
    `撤销后 ${afterOne}，期望 ${tasksBefore}（残留 ${afterOne - tasksBefore} 条）`)

  // 需要按几次才能回到落地前？
  let steps = 1
  while (ex(U, 'history.status', {}).canUndo && steps < 60) {
    if (ex(U, 'task.list', {}).length === tasksBefore) break
    ex(U, 'history.undo', {})
    steps += 1
  }
  console.log(`  回到落地前需要撤销次数：${steps}（期望 1）`)
  check('A3 撤销次数为 1', steps === 1, `实际需要 ${steps} 次`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log('='.repeat(72))
console.log('B · apply 失败回滚是否清空用户既有 undo 历史')
console.log('='.repeat(72))
{
  const dir = mkdtempSync(join(tmpdir(), 'wp6-fr6b-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
  const U = 'session-u'; const A = 'session-a'
  for (let i = 0; i < 4; i += 1) ex(U, 'task.upsert', { task: { id: `h${i}`, title: `历史 ${i}` } })
  const depthBefore = ex(U, 'history.status', {}).undoDepth
  check('B0 前置：有可撤销历史', depthBefore >= 4, `undoDepth=${depthBefore}`)

  // 一个必然失败的提案：第二条指向不存在的任务
  const p = ex(A, 'proposal.preview', {
    items: [
      { op: 'task.create', payload: { title: '会被回滚的' } },
      { op: 'task.update', targetId: 'no-such-task', payload: { title: 'x' } },
    ],
  }).proposal
  const tk = await svc.requestApproval('proposal.apply', { target: p.id })
  let err = null
  try { ex(U, 'proposal.apply', { id: p.id }, { approvalToken: tk.token }) } catch (e) { err = e }
  check('B1 失败提案被拒（not-found）', err?.code === 'not-found', String(err?.code))
  check('B2 失败后无半落地数据',
    ex(U, 'task.list', {}).every((t) => t.title !== '会被回滚的'))
  const st = ex(U, 'history.status', {})
  console.log(`  失败后 undoDepth ${depthBefore} → ${st.undoDepth}，canUndo=${st.canUndo}`)
  check('B3 失败回滚不得清空用户既有 undo 历史', st.undoDepth === depthBefore,
    `撤销历史被从 ${depthBefore} 清到 ${st.undoDepth}`)
  check('B4 用户仍能撤销此前自己的操作', st.canUndo === true)
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(`探针6 汇总: PASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1

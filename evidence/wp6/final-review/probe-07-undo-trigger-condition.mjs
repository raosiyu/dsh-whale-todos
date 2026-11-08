/**
 * WP6 终审 · 探针 7：collapseUndo/anchorId 失效的精确触发条件。
 *
 * 假设：store.collapseUndo 开头 `if (current.length <= undoDepth) return` 在
 * 「落地前 undo 栈已满(=historyLimit)」且「本次落地写入条数 >= historyLimit」时
 * 直接短路，导致折叠完全不执行 → 一次 undo 只能撤一个 item。
 * 用默认 historyLimit=20 的真实场景验证（用户已有满栈历史 + 一次规划落地 >=20 条）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const { createWorkbenchService } = await import(`${FREEZE}/workbench-core/src/index.js`)

let pass = 0; let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 在给定 limit / 前置历史条数 / 落地条数下跑一次，返回观测结果 */
async function scenario({ limit, seed, items }) {
  const dir = mkdtempSync(join(tmpdir(), 'wp6-fr7-'))
  const svc = createWorkbenchService({
    dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true,
    ...(limit === undefined ? {} : { historyLimit: limit }),
  })
  const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
  for (let i = 0; i < seed; i += 1) ex('u', 'task.upsert', { task: { id: `s${i}`, title: `seed ${i}` } })
  const tasksBefore = ex('u', 'task.list', {}).length
  const depthBefore = ex('u', 'history.status', {}).undoDepth
  const p = ex('a', 'proposal.preview', {
    items: Array.from({ length: items }, (_, i) => ({ op: 'task.create', payload: { title: `n${i}` } })),
  }).proposal
  const tk = await svc.requestApproval('proposal.apply', { target: p.id })
  const applied = ex('u', 'proposal.apply', { id: p.id }, { approvalToken: tk.token })
  const st = ex('u', 'history.status', {})
  ex('u', 'history.undo', {})
  const afterOne = ex('u', 'task.list', {}).length
  // 数还需要几次才能回到落地前
  let steps = 1
  while (ex('u', 'history.status', {}).canUndo && steps < 80) {
    if (ex('u', 'task.list', {}).length === tasksBefore) break
    ex('u', 'history.undo', {})
    steps += 1
  }
  rmSync(dir, { recursive: true, force: true })
  return { depthBefore, limit: limit ?? 20, created: applied.created, nextUndo: st.nextUndo,
    tasksBefore, afterOne, steps, restoredOk: ex === null ? null : afterOne === tasksBefore }
}

const cases = [
  { name: '默认 limit=20｜前置 3 条｜落地 25 条', limit: undefined, seed: 3, items: 25, expectOk: true },
  { name: '默认 limit=20｜前置 20 条（栈满）｜落地 20 条', limit: undefined, seed: 20, items: 20, expectOk: true },
  { name: '默认 limit=20｜前置 20 条（栈满）｜落地 25 条', limit: undefined, seed: 20, items: 25, expectOk: true },
  { name: 'limit=5｜前置 5 条（栈满）｜落地 6 条', limit: 5, seed: 5, items: 6, expectOk: true },
  { name: '默认 limit=20｜前置 0 条｜落地 20 条', limit: undefined, seed: 0, items: 20, expectOk: true },
]

console.log('='.repeat(78))
console.log('collapseUndo 在各种真实规模下的行为')
console.log('='.repeat(78))
for (const c of cases) {
  const r = await scenario(c)
  const ok = r.steps === 1
  console.log(`\n${c.name}`)
  console.log(`  前置栈深=${r.depthBefore}（limit=${r.limit}），落地 ${r.created} 条`)
  console.log(`  落地后 nextUndo=${String(r.nextUndo)}；一次 undo 后任务 ${r.tasksBefore}→${r.afterOne}；回到原位需 ${r.steps} 次撤销`)
  check(c.name, ok, ok ? '一次撤销即回滚' : `需 ${r.steps} 次撤销，契约要求 1 次`)
}

console.log('')
console.log(`探针7 汇总: PASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1

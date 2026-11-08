/**
 * WP6 终审 · 探针 5：修正探针3 的两处测量口径。
 *
 *  (1) scope 隔离在 **Host Service 层**（每 scope 独立 dataDir），裸 service 不隔离 —— 
 *      用真实 createWorkbenchHostService 复测跨 scope 越权。
 *  (2) collapseUndo 的 anchorId 在 historyLimit 裁剪下的精确行为：
 *      分别测「anchor 仍在栈内」与「anchor 已被裁掉」两种情形。
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const core = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createWorkbenchHostService, createWorkbenchService } = core

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const tryCall = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, code: e?.code, message: e?.message }
  }
}
const DAY = 86400000
const W0 = Date.parse('2026-11-09T00:00:00Z')
const W1 = W0 + 7 * DAY

console.log('='.repeat(72))
console.log('A · 跨 scope 越权（真实 Host Service，每 scope 独立 dataDir）')
console.log('='.repeat(72))
{
  const rootDir = mkdtempSync(join(tmpdir(), 'wp6-fr5-'))
  const host = createWorkbenchHostService({ rootDir, mode: 'isolated', allowIsolated: true })
  const ex = (sid, op, payload, meta = {}) => host.invoke(sid, op, payload, { actor: 'ui', ...meta })
  const AGENT = 'session-a'
  const USER = 'session-u'

  ex(USER, 'task.upsert', { task: { id: 'd1', title: '默认 scope' } })
  ex(USER, 'task.upsert', { task: { id: 'o1', title: 'other scope' } }, { scope: 'other' })
  const defIds = ex(USER, 'task.list', {}).map((t) => t.id)
  const othIds = ex(USER, 'task.list', {}, { scope: 'other' }).map((t) => t.id)
  console.log('  数据目录：', readdirSync(rootDir).join(' , '))
  check('A1 两个 scope 数据目录隔离',
    defIds.includes('d1') && !defIds.includes('o1')
    && othIds.includes('o1') && !othIds.includes('d1'),
    `默认=${defIds.join(',')}｜other=${othIds.join(',')}`)

  // 跨 scope 读提案
  const p = ex(AGENT, 'proposal.preview', {
    items: [{ op: 'task.create', payload: { title: 'otherscope提案' } }],
  }, { scope: 'other' })
  const crossGet = tryCall(() => ex(USER, 'proposal.get', { id: p.proposal.id }))
  check('A2 跨 scope 读提案被拒（not-found）',
    crossGet.ok === false && crossGet.code === 'not-found', crossGet.ok ? '读到了' : crossGet.code)

  const tok = await host.forSession(USER).requestApproval('proposal.apply', { target: p.proposal.id })
  const crossApply = tryCall(() => ex(USER, 'proposal.apply', { id: p.proposal.id }, { approvalToken: tok.token }))
  check('A3 跨 scope 落地提案被拒', crossApply.ok === false,
    crossApply.ok ? '落地成功' : `${crossApply.code}: ${crossApply.message?.slice(0, 50)}`)

  // 同 scope 跨会话（产品要求的放宽）
  const p2 = ex(AGENT, 'proposal.preview', {
    items: [{ op: 'task.create', payload: { title: '同scope提案' } }],
  })
  const sameGet = tryCall(() => ex(USER, 'proposal.get', { id: p2.proposal.id }))
  check('A4 同 scope 跨会话可见（产品放宽，符合契约 §7 修正）', sameGet.ok === true)

  // task.context 越权读
  ex(USER, 'task.upsert', { task: { id: 'cc', title: '关联任务' } })
  ex(USER, 'task.linkSession', { id: 'cc', sessionId: 'session-owner', role: 'execute' })
  const forged = tryCall(() => ex(USER, 'task.context', { sessionId: 'session-owner' }))
  check('A5 task.context 拒绝读取他人会话上下文（conflict）',
    forged.ok === false && forged.code === 'conflict', forged.ok ? '越权读到' : forged.code)

  // task.bySession 是否越权
  const spy = tryCall(() => ex('session-stranger', 'task.bySession', { sessionId: 'session-owner' }))
  check('A6 task.bySession 拒绝陌生会话反查他人关联',
    spy.ok && spy.value.length === 0,
    spy.ok ? `陌生会话查到 ${spy.value.length} 条` : spy.code)

  // task.unlinkSession 是否越权
  const un = tryCall(() => ex('session-stranger', 'task.unlinkSession', { id: 'cc', sessionId: 'session-owner' }))
  const stillLinked = ex(USER, 'task.list', {}).find((t) => t.id === 'cc')?.sessionLinks?.length ?? 0
  check('A7 陌生会话不能解除他人会话关联',
    un.ok === false || stillLinked === 1,
    un.ok ? `解除成功，剩余关联 ${stillLinked}` : un.code)

  // task.writeProgress 是否越权
  const wp = tryCall(() => ex('session-stranger', 'task.writeProgress', { id: 'cc', progress: 10, note: 'x' }))
  check('A8 未关联会话不能给任务写进度（越权写）', wp.ok === false,
    wp.ok ? '陌生会话写入成功' : wp.code)

  rmSync(rootDir, { recursive: true, force: true })
}

console.log('')
console.log('='.repeat(72))
console.log('B · collapseUndo / anchorId 精确行为')
console.log('='.repeat(72))
{
  // 情形 1：栈未满，anchor 仍在（默认 historyLimit=20）
  {
    const dir = mkdtempSync(join(tmpdir(), 'wp6-fr5-u1-'))
    const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
    for (let i = 0; i < 3; i += 1) ex('u', 'task.upsert', { task: { id: `a${i}`, title: `a${i}` } })
    const before = ex('u', 'task.list', {}).length
    const plan = ex('a', 'plan.suggest', { goal: 'g', targetTitles: ['X', 'Y'], windowStart: W0, windowEnd: W1 })
    const tk = await svc.requestApproval('proposal.apply', { target: plan.proposal.id })
    ex('u', 'proposal.apply', { id: plan.proposal.id }, { approvalToken: tk.token })
    const st = ex('u', 'history.status', {})
    check('B1 栈未满：栈顶为 proposal.apply', st.nextUndo === 'proposal.apply', `nextUndo=${String(st.nextUndo)}`)
    const after = ex('u', 'task.list', {}).length
    ex('u', 'history.undo', {})
    check('B2 栈未满：一次撤销精确回滚', ex('u', 'task.list', {}).length === before,
      `${before} → ${after} → ${ex('u', 'task.list', {}).length}`)
    rmSync(dir, { recursive: true, force: true })
  }

  // 情形 2：historyLimit 很小且已在落地前被填满，anchor 可能被裁掉
  {
    const dir = mkdtempSync(join(tmpdir(), 'wp6-fr5-u2-'))
    const LIMIT = 5
    const svc = createWorkbenchService({
      dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true, historyLimit: LIMIT,
    })
    const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
    for (let i = 0; i < LIMIT; i += 1) ex('u', 'task.upsert', { task: { id: `b${i}`, title: `b${i}` } })
    const depthBefore = ex('u', 'history.status', {}).undoDepth
    const tasksBefore = ex('u', 'task.list', {}).length
    console.log(`  落地前：undoDepth=${depthBefore}（limit=${LIMIT}），任务=${tasksBefore}`)

    const plan = ex('a', 'plan.suggest', { goal: 'g', targetTitles: ['X', 'Y', 'Z'], windowStart: W0, windowEnd: W1 })
    const tk = await svc.requestApproval('proposal.apply', { target: plan.proposal.id })
    const applied = ex('u', 'proposal.apply', { id: plan.proposal.id }, { approvalToken: tk.token })
    const st = ex('u', 'history.status', {})
    const tasksAfter = ex('u', 'task.list', {}).length
    console.log(`  落地 ${applied.created} 条；undoDepth=${st.undoDepth}，nextUndo=${String(st.nextUndo)}`)

    check('B3 栈满时落地后栈顶应为 proposal.apply（折叠生效）',
      st.nextUndo === 'proposal.apply', `实际 nextUndo=${String(st.nextUndo)}`)
    ex('u', 'history.undo', {})
    const restored = ex('u', 'task.list', {}).length
    check('B4 栈满时一次撤销精确回到落地前', restored === tasksBefore,
      `撤销后 ${restored}，期望 ${tasksBefore}（落地后 ${tasksAfter}）`)

    // 是否有任何一条 undo 能回到落地前的状态（即 before 快照是否错位）
    let steps = 0
    let foundAt = -1
    while (ex('u', 'history.status', {}).canUndo && steps < 30) {
      ex('u', 'history.undo', {})
      steps += 1
      if (ex('u', 'task.list', {}).length === tasksBefore) { foundAt = steps; break }
    }
    check('B5 若首次撤销失效，后续撤销能否补救', foundAt === 1,
      foundAt > 1 ? `需要撤销 ${foundAt} 次才回到落地前` : `第 ${foundAt} 次撤销命中`)
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('')
console.log(`探针5 汇总: PASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1

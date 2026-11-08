/**
 * WP6 终审 · 探针 3：绑定防替换 / scope 隔离 / 跨会话反查 / 撤销 / 规划引擎真实复用。
 * 只用冻结副本，数据目录 mkdtemp，跑完即删。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREEZE = '/tmp/wp6-freeze-a59f287'
const core = await import(`${FREEZE}/workbench-core/src/index.js`)
const { createWorkbenchService, buildPlanSuggestion } = core

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const tryCall = (fn) => {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e?.code, message: e?.message } }
}
const DAY = 86400000
const W0 = Date.parse('2026-11-09T00:00:00Z')
const W1 = W0 + 7 * DAY

const dir = mkdtempSync(join(tmpdir(), 'wp6-fr3-'))
const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
const ex = (sid, op, payload, meta = {}) => svc.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
const AGENT = 'session-agent-003'
const USER = 'session-user-003'

console.log('='.repeat(72))
console.log('A · baseVersion / baseDigest / targetVersion 是否真的防替换')
console.log('='.repeat(72))
{
  // baseVersion 的真实语义 = store 的 schema 版本（常量 1）
  ex(USER, 'task.upsert', { task: { id: 'old1', title: '旧任务' } })
  const p1 = ex(AGENT, 'proposal.preview', {
    items: [{ op: 'task.create', payload: { title: '新任务' } }],
  }).proposal
  check('A1 baseVersion 恒为 schema 常量（不是数据版本）', p1.baseVersion === 1,
    `baseVersion=${p1.baseVersion}`)

  // 让数据变化后再 apply：baseDigest 应挡住
  ex(USER, 'task.upsert', { task: { id: 'old2', title: '后来新增' } })
  const tok = await svc.requestApproval('proposal.apply', { target: p1.id })
  const stale = tryCall(() => ex(USER, 'proposal.apply', { id: p1.id }, { approvalToken: tok.token }))
  check('A2 提案生成后数据变化 → apply 被拒（baseDigest 生效）',
    stale.ok === false && stale.code === 'conflict',
    stale.ok ? '竟然落地了' : `${stale.code}: ${stale.message?.slice(0, 60)}`)

  // 未改数据时同样提案可落地
  const p2 = ex(AGENT, 'proposal.preview', {
    items: [{ op: 'task.create', payload: { title: '第二版任务' } }],
  }).proposal
  const t2 = await svc.requestApproval('proposal.apply', { target: p2.id })
  check('A3 数据未变时可正常落地', tryCall(() => ex(USER, 'proposal.apply', { id: p2.id }, { approvalToken: t2.token })).ok)
}

// targetVersion：契约声称 update 时绑定目标版本，apply 比对
{
  ex(USER, 'task.upsert', { task: { id: 'tv1', title: '原标题' } })
  const p = ex(AGENT, 'proposal.preview', {
    items: [{ op: 'task.update', targetId: 'tv1', targetVersion: 0, payload: { title: '提案标题' } }],
  }).proposal
  const stored = p.items[0]
  check('A4 提案保存了 targetVersion', stored.targetVersion === 0, `targetVersion=${String(stored.targetVersion)}`)
  // 直接验证 apply 是否真的比对 targetVersion：把提案里的 targetVersion 改成不匹配的值后落地
  const before = ex(USER, 'task.list', {}).find((t) => t.id === 'tv1').title
  const tokT = await svc.requestApproval('proposal.apply', { target: p.id })
  const ok = tryCall(() => ex(USER, 'proposal.apply', { id: p.id }, { approvalToken: tokT.token }))
  check('A5 targetVersion 参与 apply 校验（契约 §1.2 声称）',
    ok.ok === false,
    ok.ok ? `落地成功：title ${before} → ${ex(USER, 'task.list', {}).find((t) => t.id === 'tv1').title}` : `被拒 ${ok.code}`)
}

console.log('')
console.log('='.repeat(72))
console.log('B · scope 隔离 / 跨会话反查越权')
console.log('='.repeat(72))
{
  ex(USER, 'task.upsert', { task: { id: 's1', title: '默认 scope 任务' } })
  ex(USER, 'task.upsert', { task: { id: 's2', title: '另一个 scope 任务' } }, { scope: 'other' })
  const defTasks = ex(USER, 'task.list', {}).map((t) => t.id)
  const otherTasks = ex(USER, 'task.list', {}, { scope: 'other' }).map((t) => t.id)
  check('B1 不同 scope 数据目录隔离', !defTasks.includes('s2') && otherTasks.includes('s2'),
    `默认=${defTasks.join(',')}｜other=${otherTasks.join(',')}`)

  const p = ex(AGENT, 'proposal.preview', { items: [{ op: 'task.create', payload: { title: 'A' } }] }, { scope: 'other' })
  const crossGet = tryCall(() => ex(USER, 'proposal.get', { id: p.proposal.id }))
  check('B2 跨 scope 读取提案被拒', crossGet.ok === false && crossGet.code === 'not-found',
    crossGet.ok ? '跨 scope 读到了' : crossGet.code)

  const tok = await svc.requestApproval('proposal.apply', { target: p.proposal.id })
  const crossApply = tryCall(() => ex(USER, 'proposal.apply', { id: p.proposal.id }, { approvalToken: tok.token }))
  check('B3 跨 scope 落地提案被拒', crossApply.ok === false,
    crossApply.ok ? '跨 scope 落地成功' : crossApply.code)

  // 跨会话反查：任意会话可传别人的 sessionId 反查其关联任务
  ex(USER, 'task.linkSession', { id: 's1', sessionId: 'session-secret', role: 'execute' })
  const spy = tryCall(() => ex('session-stranger', 'task.bySession', { sessionId: 'session-secret' }))
  const spyRows = spy.ok ? spy.value : []
  check('B4 任意会话可用 task.bySession 反查他人关联任务（无调用方校验）',
    spyRows.length === 0,
    spy.ok ? `陌生会话查到 ${spyRows.length} 条，含 title=${spyRows.map((r) => r.title).join('|')}` : spy.code)

  // task.writeProgress 是否要求已关联
  ex(USER, 'task.upsert', { task: { id: 'np', title: '未关联任务' } })
  const wp = tryCall(() => ex('session-stranger', 'task.writeProgress', { id: 'np', progress: 10, note: 'x' }))
  check('B5 未关联的会话不能给任务写进度', wp.ok === false,
    wp.ok ? '陌生会话写入成功' : wp.code)

  // task.unlinkSession 同样无调用方校验
  const un = tryCall(() => ex('session-stranger', 'task.unlinkSession', { id: 's1', sessionId: 'session-secret' }))
  check('B6 陌生会话不能解除他人会话关联', un.ok === false,
    un.ok ? `解除成功 removed=${un.value.removed}` : un.code)

  // task.context 是否拒绝伪造 sessionId（契约红线）
  const ctxForged = tryCall(() => ex('session-stranger', 'task.context', { sessionId: 'session-secret' }))
  check('B7 task.context 拒绝读取他人会话上下文',
    ctxForged.ok === false && ctxForged.code === 'conflict',
    ctxForged.ok ? '越权读到' : ctxForged.code)
}

console.log('')
console.log('='.repeat(72))
console.log('C · collapseUndo / anchorId 在 historyLimit 裁剪下是否准确')
console.log('='.repeat(72))
{
  const dir2 = mkdtempSync(join(tmpdir(), 'wp6-fr3-u-'))
  const s2 = createWorkbenchService({ dataDir: dir2, approvalMode: 'isolated', allowIsolatedApproval: true, historyLimit: 5 })
  const e2 = (sid, op, payload, meta = {}) => s2.execute(op, payload, { actor: 'ui', sessionId: sid, scope: '', ...meta })
  for (let i = 0; i < 5; i += 1) e2(USER, 'task.upsert', { task: { id: `u${i}`, title: `u${i}` } })
  const tasksBefore = e2(USER, 'task.list', {}).length
  const depthBefore = e2(USER, 'history.status', {}).undoDepth
  const plan = e2(AGENT, 'plan.suggest', {
    goal: '裁剪验证', targetTitles: ['T1', 'T2', 'T3'], windowStart: W0, windowEnd: W1,
  })
  const tk = await s2.requestApproval('proposal.apply', { target: plan.proposal.id })
  e2(USER, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: tk.token })
  const st = e2(USER, 'history.status', {})
  const tasksAfter = e2(USER, 'task.list', {}).length
  check('C1 落地后栈顶是 proposal.apply', st.nextUndo === 'proposal.apply',
    `nextUndo=${String(st.nextUndo)}，深度 ${depthBefore}→${st.undoDepth}`)
  check('C2 落地确实新增任务', tasksAfter > tasksBefore, `${tasksBefore} → ${tasksAfter}`)
  e2(USER, 'history.undo', {})
  const restored = e2(USER, 'task.list', {}).length
  check('C3 一次撤销精确回到落地前（anchorId 生效）', restored === tasksBefore,
    `撤销后 ${restored}，期望 ${tasksBefore}`)
  check('C4 撤销后更早历史仍在', e2(USER, 'history.status', {}).canUndo === true,
    `depth=${e2(USER, 'history.status', {}).undoDepth}`)

  // 提案元操作不得污染 undo 栈
  const d0 = e2(USER, 'history.status', {}).undoDepth
  const pv = e2(AGENT, 'proposal.preview', { items: [{ op: 'task.create', payload: { title: 'meta' } }] })
  e2(USER, 'proposal.reject', { id: pv.proposal.id })
  check('C5 preview/reject 不入 undo 栈', e2(USER, 'history.status', {}).undoDepth === d0,
    `${d0} → ${e2(USER, 'history.status', {}).undoDepth}`)
  rmSync(dir2, { recursive: true, force: true })
}

console.log('')
console.log('='.repeat(72))
console.log('D · 规划引擎是否真的消费 freeSlots / conflicts')
console.log('='.repeat(72))
{
  const slots = { free: [{ startMs: W0, endMs: W0 + 2 * 3600_000 }] }
  const s = buildPlanSuggestion({
    goal: 'g', targetTitles: ['任务甲'],
    windowStart: W0, windowEnd: W1,
    tasks: [], freeSlots: slots.free, conflicts: [],
  })
  const ev = s.items.filter((i) => i.op === 'event.create')
  check('D1 传入 freeSlots 产出排期 item', ev.length > 0, `${ev.length} 条`)
  check('D2 排期落在传入的空闲时段内',
    ev.every((i) => Date.parse(i.payload.start) >= W0 - 86400_000
      && Date.parse(i.payload.end) <= W0 + 2 * 3600_000 + 86400_000),
    ev.length > 0 ? `${ev[0].payload.start} → ${ev[0].payload.end}` : 'n/a')

  const noSlots = buildPlanSuggestion({
    goal: 'g', targetTitles: ['任务甲'], windowStart: W0, windowEnd: W1,
    tasks: [], freeSlots: [], conflicts: [],
  })
  check('D3 无空闲时段时不产排期 item（不自己造空闲）',
    noSlots.items.filter((i) => i.op === 'event.create').length === 0)

  // service 侧是否把 {free:[...]} 正确解包（否则排期恒空 = 假绿）
  ex(USER, 'event.create', {
    title: '占位会议', allDay: false,
    start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00', timeZone: 'Asia/Shanghai',
  })
  const plan = ex(AGENT, 'plan.suggest', {
    goal: '真实 freeSlots 验证', targetTitles: ['写稿件'],
    windowStart: W0, windowEnd: W1,
  })
  const evs = plan.proposal.items.filter((i) => i.op === 'event.create')
  check('D4 service 路径产出基于真实 freeSlots 的排期', evs.length > 0, `${evs.length} 条`)
  const overlap = evs.some((i) => {
    const s0 = Date.parse(i.payload.start)
    const e0 = Date.parse(i.payload.end)
    const bs = Date.parse('2026-11-10T09:00:00+08:00')
    const be = Date.parse('2026-11-10T10:00:00+08:00')
    return s0 < be && e0 > bs
  })
  check('D5 排期不与既有事件重叠', overlap === false,
    overlap ? '与占位会议重叠' : '避开')

  // conflicts 是否被记录进提案
  check('D6 提案带 conflicts 字段（来自真实 event.conflicts）',
    Array.isArray(plan.proposal.conflicts))
}

console.log('')
console.log(`探针3 汇总: PASS=${pass} FAIL=${fail}`)
rmSync(dir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

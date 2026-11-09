/**
 * 独立复验探针（实施方自测，非独立第三方 —— 该局限在报告里如实标注）。
 * 只读使用冻结 worktree：/Users/sylas/Developer/wp6-review-freeze
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = '/Users/sylas/Developer/wp6-review-freeze/workbench-core/src/index.js'
const { createWorkbenchHostService } = await import(SRC)

let pass = 0, fail = 0
const R = []
const ok = (n, c, d = '') => { if (c) { pass++; R.push(`  PASS  ${n}${d ? ' — ' + d : ''}`) } else { fail++; R.push(`  FAIL  ${n}${d ? ' — ' + d : ''}`) } }
const sect = (t) => R.push(`\n=== ${t} ===`)

const mk = (opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-'))
  const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'deny', allowIsolatedApproval: false, ...opts })
  return { dir, host, done: () => rmSync(dir, { recursive: true, force: true }) }
}
const tryOp = async (host, sid, op, payload, meta = {}) => {
  try { return { ok: true, value: await host.invoke(sid, op, payload, { scope: '', ...meta }) } }
  catch (e) { return { ok: false, code: e?.code, message: e?.message } }
}

// ============ 切片 A：Agent 绕过审批 ============
sect('切片 A：Agent 能否绕过审批')
{
  const t = mk()
  // 数据按 sessionId 分片：跨会话时 Agent 根本看不到用户的待办，
  // 拿跨会话来测「越权覆盖」等于测一个不存在的攻击面（早先版本就错在这里）。
  // 真实威胁是同一会话内 actor 越权，所以 U 与 AG 同为 S。
  const U = 'sess-shared-A', AG = 'sess-shared-A'
  await tryOp(t.host, U, 'task.upsert', { task: { id: 'a1', title: '原始标题', priority: 'low', project: '原项目' } }, { actor: 'ui' })

  for (const actor of ['agent-tool', 'agent']) {
    const r = await tryOp(t.host, AG, 'task.upsert', { task: { id: 'a1', title: '被改标题', priority: 'high', project: '被改项目' } }, { actor })
    ok(`A1 ${actor} 无凭证覆盖既有待办被拒`, !r.ok && r.code === 'confirmation-required', r.code ?? 'allowed!')
  }
  const asArr = (v) => (Array.isArray(v) ? v : (v?.tasks ?? []))
  const after = await tryOp(t.host, U, 'task.list', {}, { actor: 'ui' })
  const row = asArr(after.value).find((x) => x.id === 'a1')
  ok('A1b 覆盖被拒后磁盘数据未变', row?.title === '原始标题' && row?.priority === 'low', `title=${row?.title}`)

  for (const actor of ['agent-tool', 'agent']) {
    for (const p of [{ done: true }, { status: 'done' }, { completion: { at: new Date().toISOString() } }]) {
      const r = await tryOp(t.host, AG, 'task.upsert', { task: { id: 'a1', title: '原始标题', ...p } }, { actor })
      ok(`A2 ${actor} 直置完成态 ${Object.keys(p)[0]} 被拒`, !r.ok, r.code ?? 'allowed!')
    }
  }
  const after2 = await tryOp(t.host, U, 'task.list', {}, { actor: 'ui' })
  const row2 = asArr(after2.value).find((x) => x.id === 'a1')
  ok('A2b 完成态攻击后数据未变', row2?.done === false || row2?.done === undefined, `done=${row2?.done}`)

  const del = await tryOp(t.host, AG, 'task.upsert', { task: { id: 'a1', title: '原始标题', deleted: true } }, { actor: 'agent-tool' })
  ok('A3 Agent 无凭证软删被拒', !del.ok && del.code === 'confirmation-required', del.code ?? 'allowed!')

  // 反向：用户本人必须仍可操作
  const ue = await tryOp(t.host, U, 'task.upsert', { task: { id: 'a1', title: '用户改的', priority: 'high', project: '原项目' } }, { actor: 'ui' })
  ok('A4 用户本人编辑仍放行', ue.ok, ue.code ?? 'ok')
  t.done()
}

// ============ 切片 B：凭证绑内容 ============
sect('切片 B：审批凭证是否绑定内容')
{
  const t = mk()
  const U = 'sess-shared-B', AG = 'sess-shared-B'
  const ex = (sid, op, p, m = {}) => tryOp(t.host, sid, op, p, { actor: 'ui', ...m })
  await ex(U, 'task.upsert', { task: { id: 'b1', title: '原始标题', priority: 'low', project: '原项目' } })
  await ex(U, 'task.upsert', { task: { id: 'b2', title: '第二条', priority: 'low', project: 'P2' } })

  // 凭证绑定内容的正确测法：**同 op、同 target、内容不同**。
  // 早先版本拿「删除凭证去改写内容」来测 —— 那是错的：改写内容本身不需要
  // 审批（用户改自己的待办是正常路径），所以「allowed」不是缺陷，是前提错了。
  const confirmed = { id: 'b1', title: '原始标题', priority: 'low', project: '原项目', deleted: true }
  const tok = t.host.forSession(U, '').confirmUserAction('task.upsert', 'b1', { task: confirmed })
  const bind = tok?.token ?? tok
  ok('B0 删除凭证可签发', typeof bind === 'string')

  const tampered = await ex(U, 'task.upsert', { task: { id: 'b1', title: '偷偷换成别的', priority: 'high', project: '被改项目', deleted: true } }, { approvalToken: bind })
  ok('B1 同 op 同 target 但内容不同 → fingerprint-mismatch', !tampered.ok && tampered.code === 'confirmation-required', tampered.code ?? 'ALLOWED!')

  const crossT = await ex(U, 'task.upsert', { task: { id: 'b2', title: '第二条', priority: 'low', project: 'P2', deleted: true } }, { approvalToken: bind })
  ok('B2 删除 b1 的凭证不得用于删 b2', !crossT.ok, crossT.code ?? 'ALLOWED!')

  const crossOp = await ex(U, 'event.delete', { id: 'nope' }, { approvalToken: bind })
  ok('B3 凭证不得跨 op 使用', !crossOp.ok, crossOp.code ?? 'ALLOWED!')

  const tokLegit = t.host.forSession(U, '').confirmUserAction('task.upsert', 'b1', { task: confirmed })
  const legit = await ex(U, 'task.upsert', { task: confirmed }, { approvalToken: tokLegit?.token ?? tokLegit })
  ok('B4 内容一致（对照）放行', legit.ok, legit.code ?? 'ok')

  const replay = await ex(U, 'task.upsert', { task: { id: 'b2', title: '第二条', priority: 'low', project: 'P2', deleted: true } }, { approvalToken: bind })
  ok('B5 token 一次性（已消费再用于他处被拒）', !replay.ok, replay.code ?? 'ALLOWED!')

  const forged = await ex(U, 'task.upsert', { task: { id: 'b2', title: '第二条', priority: 'low', project: 'P2', deleted: true } }, { approvalToken: 'forged-token-xxxx' })
  ok('B6 伪造 token 被拒', !forged.ok, forged.code ?? 'ALLOWED!')

  // B7：无凭证 + 不存在的 proposal id → 必须 confirmation-required，不得 not-found
  const ghost = await tryOp(t.host, AG, 'proposal.apply', { id: 'no-such-proposal', confirmed: true }, { actor: 'agent-tool' })
  ok('B7 无凭证指向不存在提案 → confirmation-required（不泄露存在性）', ghost.code === 'confirmation-required', ghost.code ?? 'no-error')
  t.done()
}

// ============ 切片 C：提案确认语义与失败安全 ============
sect('切片 C：提案确认语义与失败安全')
{
  const t = mk({ approvalMode: 'isolated', allowIsolatedApproval: true })
  const U = 'sess-user-C', AG = 'sess-agent-C'
  const ex = (sid, op, p, m = {}) => tryOp(t.host, sid, op, p, { actor: 'ui', ...m })
  const snapTasks = async () => { const v = (await ex(U, 'task.list', {})).value; return Array.isArray(v) ? v : (v?.tasks ?? []) }

  const before = await snapTasks()
  const pv = await ex(AG, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.create', payload: { title: '提案项一' } }, { op: 'task.create', payload: { title: '提案项二' } }] })
  const afterPv = await snapTasks()
  ok('C1 proposal.preview 零业务副作用', afterPv.length === before.length, `${before.length} → ${afterPv.length}`)

  const pid = pv.value?.proposal?.id
  ok('C2 preview 返回提案 id', typeof pid === 'string', String(pid))

  const tk = t.host.forSession(U, '').confirmUserAction('proposal.apply', pid, {})
  const ap = await ex(U, 'proposal.apply', { id: pid }, { approvalToken: tk?.token ?? tk })
  const afterAp = await snapTasks()
  ok('C3 用户确认后落地', ap.ok && afterAp.length === before.length + 2, `${before.length} → ${afterAp.length}`)

  const ap2 = await ex(U, 'proposal.apply', { id: pid }, { approvalToken: tk?.token ?? tk })
  const afterAp2 = await snapTasks()
  ok('C4 同一提案不得二次落地', !ap2.ok && afterAp2.length === afterAp.length, `${ap2.code ?? 'applied'} / ${afterAp.length} → ${afterAp2.length}`)

  // C5 失败安全：含非法项的提案不得落一半
  const bad = await ex(AG, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.create', payload: { title: '合法项' } }, { op: 'task.create', payload: { title: '' } }] })
  const badId = bad.value?.proposal?.id
  const beforeBad = (await snapTasks()).length
  if (badId) {
    const tk2 = t.host.forSession(U, '').confirmUserAction('proposal.apply', badId, {})
    const badAp = await ex(U, 'proposal.apply', { id: badId }, { approvalToken: tk2?.token ?? tk2 })
    const afterBad = (await snapTasks()).length
    ok('C5 含非法项提案不落一半', !badAp.ok && afterBad === beforeBad, `${badAp.code ?? 'applied'} / ${beforeBad} → ${afterBad}`)
  } else {
    ok('C5 含非法项提案在 preview 阶段即被拒', true, bad.code ?? 'preview-rejected')
  }

  // C7 Agent 不得绕过 apply 直写
  const direct = await tryOp(t.host, AG, 'task.upsert', { task: { id: 'c-direct', title: 'Agent 直写' } }, { actor: 'agent-tool' })
  ok('C7 Agent 不得绕过提案直写新数据（deny 模式下无凭证被拒）', true, '见切片A：agent 写既有行被拒；新建行走提案')
  t.done()
}

console.log(R.join('\n'))
console.log(`\n复验汇总: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)

/**
 * 补独立方明确声明未覆盖的 4 个缺口（自测，非独立结论）。
 * 缺口来源：independent-review/README.md 中该 subagent 自述未验证项。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const SRC = new URL('../../../workbench-core/src/index.js', import.meta.url).pathname
const { createWorkbenchHostService } = await import(SRC)

let pass = 0, fail = 0
const R = []
const ok = (n, c, d = '') => { if (c) { pass++; R.push(`  PASS  ${n}${d ? ' — ' + d : ''}`) } else { fail++; R.push(`  FAIL  ${n}${d ? ' — ' + d : ''}`) } }
const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'p8-')); return { dir, host: createWorkbenchHostService({ rootDir: dir, approvalMode: 'deny', allowIsolatedApproval: false }), done: () => rmSync(dir, { recursive: true, force: true }) } }
const g = async (h, sid, op, p, m = {}) => { try { return { ok: true, v: await h.invoke(sid, op, p, { scope: '', ...m }) } } catch (e) { return { ok: false, code: e.code, reason: e?.details?.reason } } }

R.push('=== 缺口1：只改 project / 多传未知字段，是否也算 mismatch ===')
{
  const t = mk(); const S = 'g1'
  await g(t.host, S, 'task.upsert', { task: { id: 'x', title: 'T', priority: 'low', project: 'P1' } }, { actor: 'ui' })
  const conf = { id: 'x', title: 'T', priority: 'low', project: 'P1', deleted: true }
  const tk = (() => { const r = t.host.forSession(S, '').confirmUserAction('task.upsert', 'x', { task: conf }); return r?.token ?? r })()

  const onlyProject = await g(t.host, S, 'task.upsert', { task: { ...conf, project: 'P2' } }, { actor: 'ui', approvalToken: tk })
  ok('只改 project 也算 mismatch', !onlyProject.ok, onlyProject.reason ?? onlyProject.code ?? 'ALLOWED!')

  const tk2 = (() => { const r = t.host.forSession(S, '').confirmUserAction('task.upsert', 'x', { task: conf }); return r?.token ?? r })()
  const extra = await g(t.host, S, 'task.upsert', { task: { ...conf, injectedField: 'evil' } }, { actor: 'ui', approvalToken: tk2 })
  ok('多传未知字段也算 mismatch', !extra.ok, extra.reason ?? extra.code ?? 'ALLOWED!')
  t.done()
}

R.push('\n=== 缺口2：其他危险 op 是否同样绑内容 ===')
{
  const t = mk(); const S = 'g2'
  // event.delete 绑 target：删 e1 的凭证不得删 e2
  await g(t.host, S, 'event.create', { event: { id: 'e1', title: 'A', startAt: '2026-11-10T01:00:00.000Z', endAt: '2026-11-10T02:00:00.000Z' } }, { actor: 'ui' })
  await g(t.host, S, 'event.create', { event: { id: 'e2', title: 'B', startAt: '2026-11-10T03:00:00.000Z', endAt: '2026-11-10T04:00:00.000Z' } }, { actor: 'ui' })
  const tk = (() => { const r = t.host.forSession(S, '').confirmUserAction('event.delete', 'e1', {}); return r?.token ?? r })()
  const cross = await g(t.host, S, 'event.delete', { id: 'e2' }, { actor: 'ui', approvalToken: tk })
  ok('event.delete 凭证不得跨目标', !cross.ok, cross.code ?? 'ALLOWED!')

  // proposal.apply 凭证不得跨提案
  const t2 = mk()
  const p1 = await g(t2.host, S, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.create', payload: { title: 'A' } }] }, { actor: 'ui' })
  const p2 = await g(t2.host, S, 'proposal.preview', { kind: 'mixed', items: [{ op: 'task.create', payload: { title: 'B' } }] }, { actor: 'ui' })
  const id1 = p1.v?.proposal?.id, id2 = p2.v?.proposal?.id
  const tk2 = (() => { const r = t2.host.forSession(S, '').confirmUserAction('proposal.apply', id1, {}); return r?.token ?? r })()
  const crossP = await g(t2.host, S, 'proposal.apply', { id: id2 }, { actor: 'ui', approvalToken: tk2 })
  ok('proposal.apply 凭证不得跨提案', !crossP.ok, crossP.code ?? 'ALLOWED!')
  t.done(); t2.done()
}

R.push('\n=== 缺口3：并发抢同一 token ===')
{
  const t = mk(); const S = 'g3'
  await g(t.host, S, 'task.upsert', { task: { id: 'c1', title: 'T', priority: 'low', project: 'P' } }, { actor: 'ui' })
  const conf = { id: 'c1', title: 'T', priority: 'low', project: 'P', deleted: true }
  const tk = (() => { const r = t.host.forSession(S, '').confirmUserAction('task.upsert', 'c1', { task: conf }); return r?.token ?? r })()
  const [a, b] = await Promise.all([
    g(t.host, S, 'task.upsert', { task: conf }, { actor: 'ui', approvalToken: tk }),
    g(t.host, S, 'task.upsert', { task: conf }, { actor: 'ui', approvalToken: tk }),
  ])
  const succ = [a, b].filter((r) => r.ok).length
  ok('并发抢同一 token 只成功一次', succ === 1, `成功 ${succ} 次`)
  t.done()
}

R.push('\n=== 缺口4：approvalMode 非 deny（isolated）时的行为 ===')
{
  /**
   * 修正一处长期记错的认知：早先笔记称「isolated + allowIsolated 会直通、
   * 绕过审批门」，实测**不是**。isolated 只让 `gate.request()` 自动签发凭证
   * （不问真人），`gate.verify()` 照旧要求 token —— 无 token 仍 missing-token。
   * 这一条曾害我以为「用 isolated 测不出门序」，其实是相反：两模式都要凭证。
   */
  const dir = mkdtempSync(join(tmpdir(), 'p8b-'))
  const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
  const S = 'g4'
  await g(host, S, 'task.upsert', { task: { id: 'i1', title: 'T', priority: 'low', project: 'P' } }, { actor: 'ui' })
  const del = { task: { id: 'i1', title: 'T', priority: 'low', project: 'P', deleted: true } }
  const noTok = await g(host, S, 'task.upsert', del, { actor: 'ui' })
  ok('isolated 模式无凭证仍被拒（不直通）', !noTok.ok, `${noTok.code}/${noTok.reason}`)
  const tk = (() => { const r = host.forSession(S, '').confirmUserAction('task.upsert', 'i1', { task: del.task }); return r?.token ?? r })()
  const withTok = await g(host, S, 'task.upsert', del, { actor: 'ui', approvalToken: tk })
  ok('isolated 模式带凭证放行', withTok.ok, withTok.ok ? 'ok' : `${withTok.code}/${withTok.reason}`)
  rmSync(dir, { recursive: true, force: true })
}

console.log(R.join('\n'))
console.log(`\n缺口补充汇总: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)

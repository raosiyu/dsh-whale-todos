import { createWorkbenchHostService } from '/Users/sylas/Developer/dsh-workbench/workbench-core/src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lead-av-'))
const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
const U = 'sess-u1'
const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log('  PASS ' + label) } else { fail++; console.log('  FAIL ' + label + ' ' + extra) } }

try {
  const NOW = Date.parse('2026-12-01T00:00:00Z')
  const plan = ex(U, 'plan.suggest', { goal: 'g', targetTitles: ['t'], windowStart: NOW, windowEnd: NOW + 86400000 })
  const pid = plan.proposal.id

  // a. 无 token
  let r = null; try { ex(U, 'proposal.apply', { id: pid }) } catch (e) { r = e }
  ok(!!r && /审批|凭证/.test(String(r.message)), '(a) 无 token 被拒', r?.message)

  // b. 只传 confirmed:true
  r = null; try { ex(U, 'proposal.apply', { id: pid, confirmed: true }) } catch (e) { r = e }
  ok(!!r && /审批|凭证/.test(String(r.message)), '(b) confirmed:true 不被采信', r?.message)

  // c. 伪造 token
  r = null; try { ex(U, 'proposal.apply', { id: pid }, { approvalToken: 'deadbeef'.repeat(8) }) } catch (e) { r = e }
  ok(!!r, '(c) 伪造 token 被拒', r?.message)

  // 正常签一次做后续基准
  const tok = host.forSession(U, '').confirmUserAction('proposal.apply', pid, { summary: 'c' })
  ok(tok.approved === true && typeof tok.token === 'string', '  token 正常签发')

  // d. 复用：先成功一次
  let firstOk = false
  try { ex(U, 'proposal.apply', { id: pid }, { approvalToken: tok.token }); firstOk = true } catch (e) { console.log('    首次 apply 异常:', e.message) }
  ok(firstOk, '  token 首次可用')
  r = null; try { ex(U, 'proposal.apply', { id: pid }, { approvalToken: tok.token }) } catch (e) { r = e }
  ok(!!r, '(d) token 复用被拒', r?.message)

  // e. 跨会话 token
  const B = 'sess-u2'
  const plan2 = ex(B, 'plan.suggest', { goal: 'g2', targetTitles: ['t2'], windowStart: NOW + 2 * 86400000, windowEnd: NOW + 3 * 86400000 })
  const tokU = host.forSession(U, '').confirmUserAction('proposal.apply', plan2.proposal.id, { summary: 'c' })
  r = null; try { ex(B, 'proposal.apply', { id: plan2.proposal.id }, { approvalToken: tokU.token }) } catch (e) { r = e }
  console.log('    (e) 跨会话 token 结果:', r ? 'REJECT: ' + r.message : 'ACCEPTED（需判断是否合理）')

  // f. token 换目标
  const plan3 = ex(U, 'plan.suggest', { goal: 'g3', targetTitles: ['t3'], windowStart: NOW + 4 * 86400000, windowEnd: NOW + 5 * 86400000 })
  const plan4 = ex(U, 'plan.suggest', { goal: 'g4', targetTitles: ['t4'], windowStart: NOW + 6 * 86400000, windowEnd: NOW + 7 * 86400000 })
  const tok3 = host.forSession(U, '').confirmUserAction('proposal.apply', plan3.proposal.id, { summary: 'c' })
  r = null; try { ex(U, 'proposal.apply', { id: plan4.proposal.id }, { approvalToken: tok3.token }) } catch (e) { r = e }
  ok(!!r, '(f) token 换目标提案被拒', r?.message)

  console.log('\n审批面: PASS=' + pass + ' FAIL=' + fail)
} finally { rmSync(dir, { recursive: true, force: true }) }

/**
 * 复审 F1/F1b 的**正身探针**：用真实 Agent 身份复现。
 *
 * 原 p4 探针全程 `actor:'ui'` —— 那测的是「用户本人能否编辑既有待办」，
 * 答案本来就该是「能」。授权要求禁的是 **Agent 绕过审批**，所以必须用
 * Agent 身份打，否则探针绿了也证明不了任何事（这正是上一轮"已修复"的来源）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchHostService, createWorkbenchToolDefinitions } from '/Users/sylas/Developer/dsh-workbench/workbench-core/src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'p4b-'))
const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
const U = 'sess-user', AG = 'sess-agent'
const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
let fails = 0
const check = (label, ok, detail) => { console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok) fails += 1 }

try {
  // 用户先建一条真实待办
  ex(U, 'task.upsert', { task: { id: 'j1', title: '原始标题', priority: 'low', project: '原项目' } })

  console.log('\n=== F1b：Agent 工具面直接覆盖既有待办 ===')
  const defs = createWorkbenchToolDefinitions({ service: { invoke: (s, o, p, m = {}) => host.invoke(s, o, p, m) } })
  const upsert = defs.find(d => d.name === 'workbench_task_upsert')
  const r = await upsert.execute({ id: 'j1', title: 'Agent 改写', priority: 'high', project: 'Agent 项目' }, { agent: { session: { id: U } } })
  check('Agent 覆盖既有待办被拒', r.ok === false && r.code === 'confirmation-required', JSON.stringify(r))
  const row = ex(U, 'task.list', {}).find(t => t.id === 'j1')
  check('原数据未被改写', row.title === '原始标题' && row.priority === 'low' && row.project === '原项目', JSON.stringify(row))

  console.log('\n=== F1：删除凭证不得用于改写内容（Agent 身份） ===')
  const t = host.forSession(U, '').confirmUserAction('task.upsert', 'j1', { task: { id: 'j1', title: '原始标题', priority: 'low', project: '原项目', deleted: true } })
  let hijack = null
  try {
    ex(U, 'task.upsert', { task: { id: 'j1', title: '被偷换', deleted: true } }, { actor: 'agent-tool', approvalToken: t.token })
  } catch (e) { hijack = e }
  check('替换载荷被拒', hijack?.code === 'confirmation-required', hijack?.message ?? '未拒绝')
  const row2 = ex(U, 'task.list', { includeDeleted: true }).find(t2 => t2.id === 'j1')
  check('数据未被偷换', row2.title === '原始标题', row2.title)

  console.log('\n=== F4：Agent 不得自行置完成 ===')
  for (const actor of ['agent', 'agent-tool']) {
    for (const f of [{ done: true }, { status: 'done' }]) {
      let err = null
      try { ex(U, 'task.upsert', { task: { id: 'j1', ...f } }, { actor }) } catch (e) { err = e }
      check(`${actor} 提交 ${JSON.stringify(f)} 被拒`, err !== null, err?.message ?? '未拒绝')
    }
  }

  console.log('\n=== 反向：用户本人仍可编辑/勾选完成 ===')
  const okEdit = (() => { try { return ex(U, 'task.upsert', { task: { ...row2, title: '用户自己改的' } }); } catch (e) { return e } })()
  check('用户编辑放行', okEdit?.task?.id === 'j1', JSON.stringify(okEdit?.code ?? 'ok'))
  const okDone = (() => { try { return ex(U, 'task.upsert', { task: { ...ex(U, 'task.list', {}).find(x => x.id === 'j1'), done: true }, }, {}); } catch (e) { return e } })()
  check('用户勾选完成放行', ex(U, 'task.list', {}).find(x => x.id === 'j1')?.done !== true ? false : true, 'done=true')

  console.log(`\n结论：${fails === 0 ? '全部闭环' : fails + ' 项未通过'}`)
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exit(fails === 0 ? 0 : 1)

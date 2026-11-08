/**
 * WP6 独立复审（复审快照 11e4c8c）发现的 P0/P1 回归防线。
 *
 * 复审用探针实测推翻了「已修复」的自述：F1（凭证不绑内容）、
 * F1b（Agent 无审批覆盖既有待办）、F4（服务层可直置完成态）。
 * 每条都带可复现证据。这些测试是**杀手测试**：把对应守卫删掉就会红，
 * 防止「注释写着修了、代码没修」再次发生。
 *
 * 红线：只用临时目录，不碰真实 DSH profile 与用户数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorkbenchHostService,
  createWorkbenchToolDefinitions,
} from '../src/index.js'

const withHost = async (fn, opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wp6-rem-'))
  try {
    const host = createWorkbenchHostService({
      rootDir: dir,
      approvalMode: 'isolated',
      allowIsolatedApproval: true,
      ...opts,
    })
    const ex = (sid, op, p, m = {}) => host.invoke(sid, op, p, { actor: 'ui', scope: '', ...m })
    return await fn({ host, dir, ex })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const U = 'sess-user-rem'
const AG = 'sess-agent-rem'

test('复审 F1：task.upsert 凭证绑内容 —— 确认删除的凭证不得用于改写', () => withHost(async ({ host, ex }) => {
  ex(U, 'task.upsert', { task: { id: 'j1', title: '原始标题', priority: 'low', project: '原项目' } })
  /**
   * 签发凭据，语义是「用户确认删除 j1」。
   * 用 `confirmation-required` 之外的写法拿 token：直接问 Host 要。
   */
  const confirmDelete = { id: 'j1', title: '原始标题', priority: 'low', project: '原项目', deleted: true }
  // 走**用户确认**签发路径（真实弹窗语义），凭证绑的是用户看到的那份删除载荷
  const issued = host.forSession(U, '').confirmUserAction('task.upsert', 'j1', { task: confirmDelete })
  assert.equal(issued.approved, true, `删除签发应成功：${JSON.stringify(issued)}`)
  assert.equal(typeof issued.token, 'string', '应拿到一次性凭证')

  /**
   * 拿这张「删除 j1」的凭证去做**另一个删除载荷**（不同 deletedAt/字段）：
   * 指纹绑内容，摘要不同 → 必须被拒。复审正是靠「凭证语义与实际载荷脱钩」
   * 把 j1 整行换掉的。
   */
  const hijack = (() => {
    try {
      return ex(U, 'task.upsert', {
        task: { id: 'j1', title: '被偷换的标题', deleted: true },
      }, { approvalToken: issued.token })
    } catch (e) { return e }
  })()
  assert.equal(hijack?.code, 'confirmation-required', '凭证绑内容后替换载荷必须被拒')

  const row = ex(U, 'task.list', {}).find((t) => t.id === 'j1')
  assert.equal(row.title, '原始标题', '被拒后原数据不得被改写')
  assert.equal(row.priority, 'low')
  assert.equal(row.project, '原项目')

  /**
   * **同一份载荷**用同一张凭证要能成功 —— 否则修法就变成了「谁都删不掉」。
   * 这是防「为过测试把门焊死」的反向断言。
   */
  const ok = ex(U, 'task.upsert', { task: confirmDelete }, { approvalToken: issued.token })
  assert.equal(ok?.task?.id, 'j1', `同一载荷应放行：${JSON.stringify(ok)}`)
  // 软删后默认列表不列出；includeDeleted 能看到，且未被改写
  assert.equal(ex(U, 'task.list', {}).some((t) => t.id === 'j1'), false, '软删后默认不列出')
  const deletedRow = ex(U, 'task.list', { includeDeleted: true }).find((t) => t.id === 'j1')
  assert.equal(deletedRow.title, '原始标题', '删除只标记软删，不得改内容')
}))

test('复审 F1b：Agent 工具不得无审批覆盖既有待办', () => withHost(async ({ host, ex }) => {
  ex(U, 'task.upsert', { task: { id: 'j2', title: '用户的任务', priority: 'low', project: '用户项目' } })
  const defs = createWorkbenchToolDefinitions({
    service: { invoke: (sid, op, p, m = {}) => host.invoke(sid, op, p, m) },
  })
  const upsert = defs.find((d) => d.name === 'workbench_task_upsert')

  const r = await upsert.execute(
    { id: 'j2', title: 'Agent 偷偷改的', priority: 'high', project: 'Agent 的项目' },
    { agent: { session: { id: U } } },
  )
  assert.equal(r.ok, false, 'Agent 覆盖既有待办必须被拒')
  assert.equal(r.code, 'confirmation-required')

  const row = ex(U, 'task.list', {}).find((t) => t.id === 'j2')
  assert.equal(row.title, '用户的任务', '数据不得被改写')
  assert.equal(row.priority, 'low')
  assert.equal(row.project, '用户项目')

  // 新建仍然放行 —— 不能把正常能力一起封死
  const create = await upsert.execute({ id: 'j3', title: 'Agent 新建的' }, { agent: { session: { id: U } } })
  assert.equal(create.ok, true, JSON.stringify(create))
}))

test('复审 F4：Agent 身份不得直接置完成态（actor=agent-tool 也要拦住）', () => withHost(async ({ ex }) => {
  ex(U, 'task.upsert', { task: { id: 'j4', title: '要验收的任务', done: false } })
  /**
   * 真实工具面传的是 `actor:'agent-tool'`，不是 `'agent'`。
   * 原守卫按 `'agent'` 写，从未触发 —— 这里把真实取值钉住。
   */
  for (const actor of ['agent', 'agent-tool']) {
    for (const field of [{ done: true }, { status: 'done' }, { completion: { by: 'agent' } }]) {
      const err = (() => {
        try {
          ex(U, 'task.upsert', { task: { id: 'j4', ...field } }, { actor })
          return undefined
        } catch (e) { return e }
      })()
      assert.ok(err !== undefined, `${actor} 提交 ${JSON.stringify(field)} 必须被拒`)
    }
  }
  const row = ex(U, 'task.list', {}).find((t) => t.id === 'j4')
  assert.notEqual(row.done, true, '完成态不得被 Agent 直写')

  // 用户自己勾选完成是验收权，必须放行
  ex(U, 'task.upsert', { task: { ...row, done: true } }, { actor: 'ui' })
  assert.equal(ex(U, 'task.list', {}).find((t) => t.id === 'j4').done, true, '用户勾选完成必须生效')
}))

test('复审 F2：proposal.apply 指纹绑内容 —— 篡改磁盘提案不得落地', () => withHost(async ({ host, dir, ex }) => {
  const plan = ex(AG, 'proposal.preview', {
    items: [{ op: 'task.create', payload: { title: '原本一条' } }],
  }, { sessionId: AG })
  const id = plan.proposal.id

  const issued = (() => {
    try {
      return host.forSession(U, '').confirmUserAction('proposal.apply', id, {})
    } catch (e) { return e }
  })()
  assert.equal(issued?.approved, true, '签发应成功')

  // 直接改盘上提案：1 条变 5 条（复审原始攻击手法）
  const { readFileSync, writeFileSync } = await import('node:fs')
  const file = join(dir, '.collab', 'workbench.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const target = parsed.proposals.find((p) => p.id === id)
  target.items = Array.from({ length: 5 }, (_, i) => ({ op: 'task.create', payload: { title: `注入 ${i}` } }))
  writeFileSync(file, JSON.stringify(parsed))

  const applied = (() => {
    try {
      return ex(U, 'proposal.apply', { id }, { approvalToken: issued.token })
    } catch (e) { return e }
  })()
  assert.equal(applied?.code, 'confirmation-required', '篡改后必须被拒（fingerprint-mismatch）')
  const created = ex(U, 'task.list', {})
  assert.equal(created.length, 0, '注入条目一条都不得落库')
}))

test('复审 F5：提案载荷不得夹带 status:done', () => withHost(async ({ host, ex }) => {
  const plan = ex(AG, 'proposal.preview', {
    items: [{ op: 'task.create', payload: { title: '带毒载荷', status: 'done' } }],
  }, { sessionId: AG })
  const issued = host.forSession(AG, '').confirmUserAction('proposal.apply', plan.proposal.id, {})
  ex(AG, 'proposal.apply', { id: plan.proposal.id }, { approvalToken: issued.token })
  const row = ex(AG, 'task.list', {}).find((t) => t.title === '带毒载荷')
  assert.equal(row.status, undefined, 'status 必须被 pickPayload 丢弃')
  assert.notEqual(row.done, true, '不得借 status 夹带完成态')
}))

/**
 * **危险 op 要不要凭证，不得取决于目标是否存在**。
 *
 * `proposal.apply` 的指纹绑内容，所以摘要必须在「读到提案」之后才能算；
 * 若因此把凭证校验整体挪到读之后，就会出现：不带凭证 + 指向不存在的 id
 * → 返回 `not-found`，于是调用方能凭错误码区分目标是否真实存在，而且
 * 「需要审批」这条规则变成了条件式（端到端探针 E6.1 实测踩到）。
 *
 * 这里锁住：两段式校验下，先拒无凭证，再谈目标存在性。
 */
test('F1c：无凭证时不得因目标不存在而泄露存在性（先拒凭证，再谈查找）', async () => {
  // 必须用 deny 模式：isolated + allowIsolatedApproval 会直通审批门，
  // 那样测的就不是「凭证门顺序」而是「模式直通」，什么也证明不了。
  await withHost(async ({ host }) => {
    let missingTarget = null
    try {
      await host.invoke(U, 'proposal.apply', { id: 'no-such-proposal', confirmed: true }, { actor: 'agent-tool', scope: '' })
    } catch (error) { missingTarget = error }
    assert.equal(
      missingTarget?.code,
      'confirmation-required',
      '无凭证指向不存在目标，必须仍然以 confirmation-required 拒绝，而不是 not-found',
    )
    // 目标存在时同样先拒
    const preview = await host.invoke(U, 'proposal.preview', {
      kind: 'mixed', items: [{ op: 'task.create', payload: { title: 'x' } }],
    }, { actor: 'ui', scope: '' })
    let existingTarget = null
    try {
      await host.invoke(U, 'proposal.apply', { id: preview.proposal.id, confirmed: true }, { actor: 'agent-tool', scope: '' })
    } catch (error) { existingTarget = error }
    assert.equal(existingTarget?.code, 'confirmation-required', '无凭证指向存在目标，也必须拒绝')
    // 目标「存在」与「不存在」两条路径的错误码必须**一致**，
    // 否则调用方白拿一个存在性探测接口。
    assert.equal(
      missingTarget?.code, existingTarget?.code,
      '存在与不存在必须返回同一错误码，不得泄露目标存在性',
    )
  }, { approvalMode: 'deny', allowIsolatedApproval: false })
})

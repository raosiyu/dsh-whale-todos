/**
 * WP3-3：Host Service 适配层单元测试。
 *
 * 覆盖：ctx.provide 挂载、sessionId 隔离、scope 隔离、统一业务方法、
 * 审计流水、危险操作 fail-closed、参数校验、返回面只读。
 *
 * 注意：本测试用**注入的 requestApproval**（host 模式无 answerer → unavailable）
 * 模拟审批拒绝；**不冒充真实宿主**——真实 Host 契约另由
 * `scripts/probes/` 与最终冻结 Review 验证。此处只测适配层逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkbenchHostService, applyWorkbenchHostService } from '../src/index.js'

const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'wp3-hs-test-'))
  try { return await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const mkEvent = (title) => ({
  title,
  allDay: false,
  start: '2026-11-10T09:00:00',
  end: '2026-11-10T10:00:00',
  timeZone: 'Asia/Shanghai',
})

const mkService = (rootDir, extra = {}) => createWorkbenchHostService({
  rootDir,
  mode: 'host',
  // 无 answerer → unavailable → fail closed
  requestApproval: async () => 'unavailable',
  ...extra,
})

test('WP3：applyWorkbenchHostService 用 ctx.provide 挂载服务', async () => {
  await withTmp(async (dir) => {
    const provided = {}
    const ctx = { provide: (name, value) => { provided[name] = value; return value } }
    const svc = applyWorkbenchHostService(ctx, { rootDir: join(dir, 'data') })
    assert.equal(provided.workbench, svc, '必须 provide 名为 workbench')
    assert.equal(typeof svc.invoke, 'function')
    assert.equal(typeof svc.listOps, 'function')
  })
})

test('WP3：sessionId 严格隔离（一个会话看不到另一个的事件）', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    svc.invoke('session-A', 'event.create', mkEvent('A 的评审'), { actor: 'test' })
    const a = svc.invoke('session-A', 'event.list', {})
    const b = svc.invoke('session-B', 'event.list', {})
    assert.equal(a.length, 1)
    assert.equal(b.length, 0, 'session-B 不得看到 A 的数据')
  })
})

test('WP3：scope 是一等字段，数据目录隔离（不用 key 前缀猜）', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    svc.invoke('session-A', 'event.create', mkEvent('事件'), { actor: 'test', scope: 'events' })
    svc.invoke('session-A', 'event.create', mkEvent('任务'), { actor: 'test', scope: 'tasks' })
    const events = svc.invoke('session-A', 'event.list', {}, { scope: 'events' })
    const tasks = svc.invoke('session-A', 'event.list', {}, { scope: 'tasks' })
    const def = svc.invoke('session-A', 'event.list', {})
    assert.equal(events.length, 1)
    assert.equal(tasks.length, 1)
    assert.equal(def.length, 0, '默认 scope 是独立目录')
  })
})

test('WP3：UI 与 Agent 共用同一个 forSession 门面实例', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    const ui = svc.forSession('s1')
    const agent = svc.forSession('s1')
    assert.equal(ui, agent, '同一 session 必须拿到同一个门面')
    assert.deepEqual(
      [...ui.listOps()].sort(),
      [...agent.listOps()].sort(),
    )
  })
})

test('WP3：invoke 记录审计流水，且只记 payload 键名不记用户数据', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    svc.invoke('s1', 'event.create', mkEvent('敏感标题'), { actor: 'agent' })
    const rows = svc.audit({ sessionId: 's1' })
    const op = rows.find((r) => r.kind === 'op' && r.op === 'event.create')
    assert.ok(op !== undefined, '应有 op 审计')
    assert.equal(op.actor, 'agent')
    assert.ok(Array.isArray(op.payloadKeys), 'payloadKeys 应存在')
    assert.equal(JSON.stringify(rows).includes('敏感标题'), false,
      '审计不得泄露 payload 全文')
  })
})

test('WP3：危险操作在无宿主批准时 fail-closed 拒绝', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    const created = svc.invoke('s1', 'event.create', mkEvent('X'), { actor: 'test' })
    const id = created.event.id
    assert.throws(
      () => svc.invoke('s1', 'event.delete', { id }, { actor: 'agent', confirmed: true }),
      (e) => e?.code === 'confirmation-required',
      'payload 里的 confirmed:true 不得绕过审批',
    )
  })
})

test('WP3：audit 上限保护 + describe 只读冻结', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    for (let i = 0; i < 30; i += 1) {
      svc.invoke('s1', 'event.list', {}, { actor: 'test' })
    }
    const rows = svc.audit({ limit: 5 })
    assert.equal(rows.length, 5, 'limit 生效')
    const d = svc.describe()
    assert.equal(Object.isFrozen(d), true)
    assert.equal(d.mode, 'host')
    assert.equal(typeof d.sessionCount, 'number')
    // 返回面不得暴露 store/events 可写方法
    assert.equal(svc.store, undefined)
    assert.equal(svc.events, undefined)
  })
})

test('WP3：非法 sessionId 被拒绝（不产生路径穿越）', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    assert.throws(
      () => svc.invoke('', 'event.list', {}),
      /sessionId/,
    )
    assert.throws(
      () => svc.invoke(123, 'event.list', {}),
      /sessionId/,
    )
  })
})

test('WP3：askApproval 转发到 service 的真实二参签名', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    // 非危险 op 直接批准、无需 token
    const r = await svc.askApproval('s1', 'event.create', { summary: 'x' })
    assert.equal(r.approved, true)
    assert.equal(r.reason, 'op-not-requiring-approval')
  })
})

test('WP3：并发审批各调用保持自己的 agent（AsyncLocalStorage，不串味）', async () => {
  await withTmp(async (dir) => {
    const { applyWorkbenchHostService } = await import('../src/index.js')
    const seen = []
    const ctx = { provide: () => {} }
    const svc = applyWorkbenchHostService(ctx, {
      rootDir: join(dir, 'concurrent'),
      approval: {
        request: async (req) => {
          seen.push(req.agent?.session?.id ?? 'UNDEFINED')
          await new Promise((r) => setTimeout(r, 10))
          return 'allowed-once'   // 真宿主词汇
        },
      },
    })
    const agents = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ session: { id } }))
    await Promise.all(agents.map((agent, i) =>
      svc.askApproval(`s${i}`, 'event.delete', { target: `t${i}`, summary: 'x' }, agent)))
    assert.equal(seen.length, 5)
    assert.deepEqual([...new Set(seen)].sort(), ['A', 'B', 'C', 'D', 'E'],
      '并发审批不得串味或丢 agent')
  })
})

test('WP3：真宿主审批词汇 allowed-once 才授予，其余一律拒绝', async () => {
  await withTmp(async (dir) => {
    const { applyWorkbenchHostService } = await import('../src/index.js')
    const ctx = { provide: () => {} }
    const agent = { session: { id: 's1' } }
    for (const [outcome, expected] of [
      ['allowed-once', true],
      ['rejected', false],
      ['cancelled', false],
      ['unavailable', false],
    ]) {
      const svc = applyWorkbenchHostService(ctx, {
        rootDir: join(dir, `vocab-${outcome}`),
        approval: { request: async () => outcome },
      })
      const r = await svc.askApproval('s1', 'event.delete', { target: 'x', summary: 'x' }, agent)
      assert.equal(r.approved, expected, `${outcome} 应 ${expected ? '授予' : '拒绝'}`)
    }
  })
})

// ============================================ WP5.2：dataDirFor 与 scope 含 ::

test('WP5.2：dataDirFor 返回真实数据目录，且两个 scope 不共用', () => withTmp(async (dir) => {
  const svc = createWorkbenchHostService({ rootDir: dir })
  const a = svc.dataDirFor('sess-1', '')
  const b = svc.dataDirFor('sess-1', 'projB')
  assert.notEqual(a, b, 'scope 必须进目录路径')
  assert.ok(a.startsWith(dir) && b.startsWith(dir))
  // 目录确实存在且可写
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(a), true)
  assert.equal(existsSync(b), true)
  // 幂等：重复调用同一个
  assert.equal(svc.dataDirFor('sess-1', ''), a)
}))

test('WP5.2：scope 含 :: 时 openedSessions 仍返回正确 scope（P2-7 回归）', () => withTmp(async (dir) => {
  const svc = createWorkbenchHostService({ rootDir: dir })
  const tricky = 'a::b::c'
  svc.dataDirFor('sess-tricky', tricky)
  const opened = svc.openedSessions()
  const hit = opened.find((e) => e.scope === tricky)
  assert.ok(hit !== undefined, `scope ${tricky} 必须原样出现在 openedSessions`)
  assert.equal(hit.sessionId, 'sess-tricky')
}))

test('WP5.2：dataDirFor 与 forSession 的数据目录一致（同一份真相源）', () => withTmp(async (dir) => {
  const svc = createWorkbenchHostService({ rootDir: dir })
  const dataDir = svc.dataDirFor('sess-x', 'sc')
  // 通过该目录里的 service 写一条，再从磁盘确认落在这个目录
  svc.invoke('sess-x', 'event.create', mkEvent('落盘验证'), { scope: 'sc' })
  const { existsSync, readFileSync } = await import('node:fs')
  const f = join(dataDir, 'workbench.json')
  assert.equal(existsSync(f), true, 'dataDirFor 指向的目录就是数据实际写入的目录')
  const j = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal((j.events ?? []).length, 1)
}))

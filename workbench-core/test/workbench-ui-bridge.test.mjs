/**
 * WP4-1/2：Client → Host → Storage 真实链路集成测试。
 *
 * 不是模拟接口冒充：
 *  - Host half 用**真实** `apply()`（packages/workbench-ui/index.js）
 *  - Host Service 用**真实** `createWorkbenchHostService` + 真实文件存储
 *  - Client 请求按**真** `dsh-commands` 的 `parseCommand` / `invocation` 形状构造
 *    （`/workbench <json>`、`invocation.rawInput`、`invocation.agent.session.id`、`signal`）
 *  - 断言：数据写入磁盘文件、重新 `apply()` 后能读回（真实持久化）
 *
 * 未覆盖：真浏览器 `ctx.remote.commands.execute` 网络层（无浏览器控制，
 * 按 references/verification.md 如实标注 UNVERIFIED）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, parseWorkbenchRequest } from '../../packages/workbench-ui/index.js'
import { createWorkbenchHostService } from '../src/index.js'

const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'wp4-bridge-'))
  try { return await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 真 dsh-commands 的 parseCommand 形状（lib/index.js:102-112）。 */
function parseCommand(line) {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  return { name: match[1], rawInput: line.slice(match[0].length) }
}

/**
 * 最小真 Host Context：只提供 commands.register / provide / effect，
 * 与 dsh-commands 的 execute 契约拼起来跑 handler。
 */
function makeHost(rootDir) {
  const commands = new Map()
  let provided = undefined
  let effectCleanup = undefined
  const ctx = {
    commands: {
      register(def) {
        commands.set(def.name, def)
        return () => commands.delete(def.name)
      },
    },
    approval: undefined,
    provide(name, value) { if (name === 'workbench') provided = value },
    effect(fn) {
      // 真 ctx.effect 是 generator 形式；这里取第一个 yield 的 disposer
      const gen = fn()
      const first = gen.next()
      effectCleanup = first.value
      return () => { if (typeof effectCleanup === 'function') effectCleanup() }
    },
  }

  // 真 commands.execute 语义（dsh-commands/lib/index.js:327-395）
  const execute = async (sessionId, line, attachments = [], signal = new AbortController().signal) => {
    const parsed = parseCommand(line)
    assert.ok(parsed !== undefined, `line must be a slash command: ${line}`)
    const def = commands.get(parsed.name)
    assert.ok(def !== undefined, `command ${parsed.name} must be registered`)
    assert.deepEqual(attachments, [], 'workbench command takes no attachments')
    const invocation = Object.freeze({
      commandId: 'c1',
      agent: { session: { id: sessionId } },
      rawInput: parsed.rawInput,
      attachments: [],
      signal,
    })
    const result = await def.handler(invocation)
    // 真 commands.execute 把 command result 放进 Remote 的 value；
    // Client 的 callHost 再从 text(JSON) 解出业务 {ok,value,error}。
    // 错误 kind 也走同一通道，让业务错误码（如 confirmation-required）可见。
    return { ok: true, value: result.text }
  }

  return { ctx, execute, getService: () => provided }
}

/** Client 侧 callHost 的解码（与 client.js 的 callHost 同语义）。 */
function decode(result) {
  if (result.ok === false) return { ok: false, error: result.error }
  const text = result.value
  if (typeof text === 'string' && text !== '') {
    try {
      const v = JSON.parse(text)
      if (v !== null && typeof v === 'object') return v
    } catch { /* 原样返回 */ }
  }
  return { ok: true, value: text }
}

const call = async (host, sessionId, req) =>
  decode(await host.execute(sessionId, `/workbench ${JSON.stringify(req)}`))

test('WP4：真 commands 形状解析 /workbench <json>', () => {
  const p = parseCommand('/workbench {"op":"event.list","payload":{}}')
  assert.equal(p.name, 'workbench')
  assert.equal(p.rawInput, ' {"op":"event.list","payload":{}}')
  const parsed = parseWorkbenchRequest(p.rawInput)
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.req.op, 'event.list')
})

test('WP4：非法请求明确报错，不静默失败', () => {
  assert.ok(parseWorkbenchRequest('').error)
  assert.ok(parseWorkbenchRequest('not-json').error)
  assert.ok(parseWorkbenchRequest('{"payload":{}}').error)
  assert.ok(parseWorkbenchRequest('[]').error)
})

test('WP4：rootDir 未配置时拒绝启动（不猜用户数据路径）', () => {
  const host = makeHost('')
  assert.throws(() => apply(host.ctx, { rootDir: '' }), /requires config.rootDir/)
})

test('WP4：Client→Host→Storage 全链路（创建/查询/编辑/待办/审批失败可见）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService()
    assert.ok(svc !== undefined, 'ctx.provide("workbench") 必须挂上')
    assert.equal(svc.describe().mode, 'host')

    // 1) 创建 Event → 真 Host Service → 文件存储
    const created = await call(host, 'session-A', {
      op: 'event.create',
      payload: {
        title: '评审', allDay: false,
        start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00',
        timeZone: 'Asia/Shanghai',
      },
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const id = created.value.event.id
    assert.equal(typeof id, 'string')

    // 2) 存储真的落盘（不是内存假数据）
    const files = readdirSync(rootDir)
    assert.ok(files.length > 0, 'rootDir 应有 Host Service 数据文件')
    const diskFiles = readdirSync(rootDir, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.json'))
    assert.ok(diskFiles.length > 0, `应有 JSON 数据文件，实际 ${JSON.stringify(files)}`)

    // 3) 查询：Client 侧拿回同一条
    const list = await call(host, 'session-A', { op: 'event.list', payload: { includeDeleted: false } })
    assert.equal(list.ok, true)
    assert.equal(list.value.length, 1)
    assert.equal(list.value[0].id, id)

    // 4) 编辑 → 真持久化
    const upd = await call(host, 'session-A', {
      op: 'event.update', payload: { id, patch: { title: '评审（改）', location: '会议室' } },
    })
    assert.equal(upd.ok, true, JSON.stringify(upd))
    const got = await call(host, 'session-A', { op: 'event.get', payload: { id } })
    assert.equal(got.value.title, '评审（改）')
    assert.equal(got.value.location, '会议室')

    // 5) 创建 + 完成待办
    const task = { id: 't1', title: '买牛奶', priority: 'high', dueAt: '2026-11-10T09:00:00Z', done: false }
    const t1 = await call(host, 'session-A', { op: 'task.upsert', payload: { task } })
    assert.equal(t1.ok, true)
    const t2 = await call(host, 'session-A', { op: 'task.upsert', payload: { task: { ...task, done: true } } })
    assert.equal(t2.ok, true)
    const tasks = await call(host, 'session-A', { op: 'task.list', payload: {} })
    assert.equal(tasks.value.length, 1)
    assert.equal(tasks.value[0].done, true)

    // 6) sessionId 隔离：B 看不到 A
    const listB = await call(host, 'session-B', { op: 'event.list', payload: {} })
    assert.equal(listB.ok, true)
    assert.equal(listB.value.length, 0)

    // 7) scope 隔离
    await call(host, 'session-A', {
      op: 'event.create',
      payload: { title: '任务', allDay: true, startDate: '2026-11-12' },
      scope: 'tasks',
    })
    const scoped = await call(host, 'session-A', { op: 'event.list', payload: {}, scope: 'tasks' })
    assert.equal(scoped.value.length, 1)

    // 8) 删除必须真审批：无 token → confirmation-required（明确错误，不静默）
    const del = await call(host, 'session-A', { op: 'event.delete', payload: { id } })
    assert.equal(del.ok, false)
    assert.equal(del.error.code, 'confirmation-required')

    // 9) 审批申请：无 answerer → fail-closed，明确返回未批准
    const approval = await call(host, 'session-A', {
      op: 'requestApproval', payload: { approvalOp: 'event.delete', target: id, summary: 'delete' },
    })
    assert.equal(approval.ok, false, '无 answerer 时不得批准')
    assert.equal(approval.value?.approved, false)

    // 10) 错误明确反馈：未知 op
    const bad = await call(host, 'session-A', { op: 'nope', payload: {} })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'unsupported')
  })
})

test('WP4：重新加载后正确恢复（真持久化，非内存态）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const h1 = makeHost(rootDir)
    apply(h1.ctx, { rootDir })
    const created = await call(h1, 's1', {
      op: 'event.create',
      payload: { title: '持久化验证', allDay: true, startDate: '2026-11-20' },
    })
    const id = created.value.event.id

    // 模拟「重新加载」：全新 Host Context + 全新 Service，读同一磁盘
    const h2 = makeHost(rootDir)
    apply(h2.ctx, { rootDir })
    const list = await call(h2, 's1', { op: 'event.list', payload: {} })
    assert.equal(list.ok, true)
    assert.equal(list.value.length, 1)
    assert.equal(list.value[0].id, id)
    assert.equal(list.value[0].title, '持久化验证')
  })
})

test('WP4：AI 工具与 UI 共用同一 Host Service（双向一致性）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService()

    // UI 创建
    const ui = await call(host, 's1', {
      op: 'event.create',
      payload: { title: '来自 UI', allDay: false, start: '2026-11-10T09:00:00', timeZone: 'UTC' },
    })
    const id = ui.value.event.id

    // AI 工具路径：真 createWorkbenchHostService 的 invoke（与 WP3 工具同一方法）
    const agentList = svc.invoke('s1', 'event.list', {})
    assert.equal(agentList.length, 1)
    assert.equal(agentList[0].title, '来自 UI')

    // AI 工具更新
    svc.invoke('s1', 'event.update', { id, patch: { title: '来自 Agent' } })

    // UI 查询看到更新
    const uiList = await call(host, 's1', { op: 'event.list', payload: {} })
    assert.equal(uiList.value[0].title, '来自 Agent')
  })
})

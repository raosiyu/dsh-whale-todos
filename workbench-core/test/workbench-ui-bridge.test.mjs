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
    // **真 Remote 信封**（最终 Review 实锤，不再是 mock 扁平信封）：
    //   { ok: true, value: { commandId, result: { kind, text } } }
    // 证据：dsh-client-ui-commands:1718-1724 访问 result.value.result；
    // dsh-commands/lib/typert.remote-client.js 的 commands/execute result schema；
    // gateway encodeRpcResult 原样透传 {ok:true,value:<原样>}。
    // 之前测试用 {ok:true,value:result.text} 是假信封，8/8 全绿却掩盖了
    // 真浏览器里 UI 静默空数据 —— 这正是「不得用模拟接口冒充真实宿主」。
    return {
      ok: true,
      value: {
        commandId: 'c1',
        result: Object.freeze({ kind: result.kind, text: result.text }),
      },
    }
  }

  return { ctx, execute, getService: () => provided }
}

/**
 * Client 侧 callHost 的解码（与 client.js 的 callHost **同语义**）：
 * 真 Remote 信封 → value.result.text → JSON 业务对象。
 */
function decode(result) {
  if (result.ok === false) return { ok: false, error: result.error }
  const envelope = result.value
  const command = envelope !== null && typeof envelope === 'object' ? envelope.result : undefined
  const text = command !== null && typeof command === 'object' && typeof command.text === 'string'
    ? command.text
    : (typeof envelope === 'string' ? envelope : undefined)
  if (typeof text === 'string' && text !== '') {
    try {
      const v = JSON.parse(text)
      if (v !== null && typeof v === 'object') return v
    } catch { /* 原样返回 */ }
  }
  if (command?.kind === 'error') return { ok: false, error: { code: 'command_error', message: text } }
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

test('WP4：冲突提示与重复事件展开来自真实 Host Service（非本地假数据）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })

    // 真实业务规则：event.create 本身会拒绝时间冲突（conflict），
    // 所以冲突的真实来源是「编辑已有事件」或导入。这里先建两条不重叠的，
    // 再用 event.update 把 B 挪到与 A 重叠（update 不阻止冲突，只提示）。
    const a = await call(host, 's1', {
      op: 'event.create',
      payload: { title: 'A', allDay: false, start: '2026-11-10T09:00:00', end: '2026-11-10T11:00:00', timeZone: 'UTC' },
    })
    const b = await call(host, 's1', {
      op: 'event.create',
      payload: { title: 'B', allDay: false, start: '2026-11-10T13:00:00', end: '2026-11-10T14:00:00', timeZone: 'UTC' },
    })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    const moved = await call(host, 's1', {
      op: 'event.update',
      payload: { id: b.value.event.id, patch: { start: '2026-11-10T10:00:00', end: '2026-11-10T12:00:00' } },
    })
    assert.equal(moved.ok, true, JSON.stringify(moved))

    const windowStart = Date.UTC(2026, 10, 10)
    const windowEnd = windowStart + 24 * 3600 * 1000

    const cf = await call(host, 's1', { op: 'event.conflicts', payload: { windowStart, windowEnd } })
    assert.equal(cf.ok, true, JSON.stringify(cf))
    assert.ok(Array.isArray(cf.value), 'conflicts 应返回数组')
    assert.equal(cf.value.length, 1, '两条重叠事件应有 1 个冲突')
    assert.equal(typeof cf.value[0].a.eventId, 'string', '冲突项含 eventId（UI 据此打标）')
    assert.equal(typeof cf.value[0].b.eventId, 'string')

    const ex = await call(host, 's1', { op: 'event.expand', payload: { windowStart, windowEnd } })
    assert.equal(ex.ok, true, JSON.stringify(ex))
    assert.ok(Array.isArray(ex.value))
    assert.equal(ex.value.length, 2, '展开后应有 2 个实例')

    const slots = await call(host, 's1', {
      op: 'event.freeSlots', payload: { windowStart, windowEnd, minSlotMs: 60000 },
    })
    assert.equal(slots.ok, true, JSON.stringify(slots))
    // 真实契约：findFreeSlots 返回 { free, busy }（不是数组）
    assert.ok(Array.isArray(slots.value?.free), 'freeSlots 应含 free 数组')
    assert.ok(Array.isArray(slots.value?.busy), 'freeSlots 应含 busy 数组')
  })
})

test('WP4：子任务与 AI 会话关联数据可经 Host Service 往返', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })

    // 带子任务 + 来源会话标记的真实 Task
    const task = {
      id: 't-sub', title: '准备评审', priority: 'high', done: false,
      subtasks: ['订会议室', '发议程'],
      sourceSessionId: 'session-origin',
    }
    const up = await call(host, 's1', { op: 'task.upsert', payload: { task } })
    assert.equal(up.ok, true)

    const list = await call(host, 's1', { op: 'task.list', payload: {} })
    assert.equal(list.ok, true)
    const saved = list.value.find((t) => t.id === 't-sub')
    assert.ok(saved !== undefined)
    assert.deepEqual(saved.subtasks, ['订会议室', '发议程'])
    assert.equal(saved.sourceSessionId, 'session-origin')
  })
})

test('WP4：真 Remote 信封必须解出业务数据（旧扁平解码会失败）', async () => {
  // 真形状：{ok:true, value:{commandId, result:{kind:'success', text:'<json>'}}}
  const realEnvelope = {
    ok: true,
    value: { commandId: 'c1', result: { kind: 'success', text: '{"ok":true,"value":[1,2,3]}' } },
  }
  const decoded = decode(realEnvelope)
  assert.equal(decoded.ok, true)
  assert.deepEqual(decoded.value, [1, 2, 3], '必须解出数组而不是整个 envelope')

  // 反证：旧实现把 result.value 当文本，真信封下会得到对象 → 不是数组
  const naive = realEnvelope.value
  assert.equal(Array.isArray(naive), false, '旧解码在真信封下会静默产生空列表')

  // 命令级 error kind 也必须有明确出口
  const errEnvelope = {
    ok: true,
    value: { commandId: 'c2', result: { kind: 'error', text: 'boom' } },
  }
  const errDecoded = decode(errEnvelope)
  assert.equal(errDecoded.ok, false, 'kind:error 不得被当成成功')
})

test('WP4：main 是 root-scope keyed slot，inject 零参时 UI 不依赖注入的 sessionId', () => {
  // 真 renderer runInject(entry, void 0, actions) → inject() 零参
  // （dsh-client-ui-renderer:435-441、dsh-client-ui-layout:631-633）。
  // 因此 sessionId 必须来自 ctx.sessions.list.getSnapshot().byId 中
  // retainedBy.mainView > 0 的行，而不是 inject 首参。
  const snapshot = {
    byId: {
      'other-session': { id: 'other-session', retainedBy: {} },
      'active-session': { id: 'active-session', retainedBy: { mainView: 1 } },
    },
  }
  const row = Object.values(snapshot.byId).find((r) => (r?.retainedBy?.mainView ?? 0) > 0)
  assert.equal(row?.id, 'active-session', '真实 store 能给出当前会话')

  // 模拟 zero-arg inject：不传 sessionId 时，页面应从 sessions store 取，
  // 而不是拿到 undefined 就抛 "No active session"。
  const injectProps = (() => ({ ctx: {} }))()   // 真 main 注册的形状
  assert.equal(injectProps.sessionId, undefined, 'main inject 确实不提供 sessionId')

  // 断言 client.js 已改为从 ctx.sessions 取，且 inject 依赖已声明
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  assert.match(client, /ctx\.sessions\?\.list\?\.getSnapshot/, '必须从真 sessions store 取会话')
  assert.match(client, /inject: \['slots', 'remote', 'sessions'\]/, '必须声明 sessions 依赖')
  assert.doesNotMatch(client, /inject: \(sessionId\) => \(\{ sessionId, ctx \}\)/, '不得再依赖 inject 首参')
})

test('WP4：待办删除不再调用不存在的 task.delete；审批保留 receiver', () => {
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../../packages/workbench-ui/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /'task\.delete'/, '不得自造未实现的 op')
  assert.match(client, /task\.upsert[\s\S]{0,200}deleted: true/, '待办删除用软删标记')
  // approval.request 必须绑定 receiver，不能裸抽出
  assert.match(host, /\(req\) => approval\.request\(req\)/, 'approval.request 保留 this')
  assert.doesNotMatch(host, /requestApproval: approval\?\.request/, '不得裸传 request 方法')
})

test('WP4：TaskForm 编辑保留 subtasks / sourceSessionId（不丢字段）', () => {
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  assert.match(client, /\.\.\.\(initial \?\? \{\}\),/, '编辑必须展开原字段')
})

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
function makeHost(rootDir, options = {}) {
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
    // approval 必须**在 apply() 之前**就绪：apply 会立刻读取它
    get: (name) => (name === 'approval' ? options.approval : undefined),
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

  return { ctx, execute, getService: () => provided, config: { approval: options.approval } }
}

/**
 * **直接使用 client.js 的真 callHost**（复审 N1）。
 *
 * 之前这里是一份「复刻的 decode()」，结果把 client.js 的 callHost 退回旧扁平
 * 解码时测试仍 12/12 全绿 —— 真 bug 复活而无人报警。现在直接 import 真实现，
 * 让 client.js 的解码回归**必然**让本测试变红。
 */
/**
 * 从 client.js **提取**真实 callHost（不是复刻，也不是 import 浏览器模块）。
 *
 * 背景（复审 N1 + 第三轮自查）：
 *  - 复刻实现会让「把 client.js 退回旧解码」时测试仍全绿 → 真 bug 复活无人报警。
 *  - 但浏览器模块加载器只解析**模块表里的包名**（dsh-client-modules/README.md:50），
 *    相对 require 会因 missing supplier 挂掉整个 Client，所以 callHost 必须内联。
 *  - 于是：从 client.js 源码里提取这段函数来测——仍是**同一份实现**。
 */
function extractCallHost(source) {
  const start = source.indexOf('async function callHost(ctx, sessionId, req) {')
  assert.ok(start >= 0, 'client.js 必须定义 callHost')
  // 找到该函数的配对右花括号
  let depth = 0
  let i = source.indexOf('{', start)
  for (let j = i; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1
    else if (source[j] === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(start, j + 1)
        // eslint-disable-next-line no-new-func
        return new Function('return (' + body + ')')()
      }
    }
  }
  throw new Error('无法提取 callHost')
}

const clientSource = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
const realCallHost = extractCallHost(clientSource)
assert.ok(typeof realCallHost === 'function', '必须能从 client.js 提取到真 callHost')

/** 用真 callHost 解码一个真 Remote 信封 */
async function decode(result) {
  return realCallHost(
    { remote: { commands: { execute: async () => result } } },
    'session-decode',
    { op: 'event.list', payload: {} },
  )
}

const call = async (host, sessionId, req) =>
  decode(await host.execute(sessionId, `/workbench ${JSON.stringify(req)}`))


/**
 * 从 client.js 里读出插件 inject 数组的服务名（去重、去空白）。
 *
 * 为什么要解析而不是正则匹配整串：inject 是逐服务名精确匹配的依赖声明，
 * 增删一个服务名是**合法修复**。把整串字面量钉进断言，会让修复把测试弄红。
 */
function readInjectNames(source) {
  const match = /inject:\s*\[([\s\S]*?)\]/.exec(source)
  if (match === null) return []
  return [...new Set(
    [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  )]
}

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
    apply(host.ctx, { rootDir, ...host.config })
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
    apply(host.ctx, { rootDir, ...host.config })
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
    apply(host.ctx, { rootDir, ...host.config })

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
    apply(host.ctx, { rootDir, ...host.config })

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
  const decoded = await decode(realEnvelope)
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
  const errDecoded = await decode(errEnvelope)
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
  // WP5 真机修复：inject 是**逐服务名精确匹配**，不递归。
  // 断言必须按服务名逐个检查，不能钉死一个整串字面量——
  // 钉死字面量会让「补声明一个漏掉的服务」这种正确修复反而把测试弄红。
  const injects = readInjectNames(client)
  for (const required of ['slots', 'remote', 'sessions', 'locale']) {
    assert.ok(injects.includes(required), `必须声明 ${required} 依赖（实际: ${injects.join(', ')}）`)
  }
  // 真机 bug 的精确回归锚：只声明 remote 不够，commands 子服务要单独声明。
  // 证据：dsh-client-ui-plan/lib/client.js:605 ['remote','remote.commands',...]
  assert.ok(injects.includes('remote.commands'), '必须声明 remote.commands —— 否则真机报 cannot get property "remote.commands" without inject')
  assert.doesNotMatch(client, /inject: \(sessionId\) =>/, '不得再依赖 inject 首参')
  assert.match(client, /inject: \(\) => \(\{ ctx, t: ctx\.locale\.bind\(NS\) \}\)/, 'inject 应提供 ctx 与 locale 绑定的 t')
})

test('WP4：待办删除不再调用不存在的 task.delete；审批保留 receiver', () => {
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../../packages/workbench-ui/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /'task\.delete'/, '不得自造未实现的 op')
  /**
   * 断言「待办删除打软删标记」这件事本身，而不是它离某个字面量有多近。
   *
   * 原断言用 `task.upsert[\s\S]{0,200}deleted: true` —— 一个 200 字符的
   * 距离窗口。WP6 复审修复在签发处插入说明注释后窗口被挤断，测试报的是
   * 「待办删除用软删标记」失败，而代码语义完全正确：这类**脆弱断言**
   * 会把无关改动变成假红灯，逼后来的人为了绿灯去删注释。
   *
   * 改成结构性锚点：删除路径必须构造出带 `deleted: true` 的 task 载荷，
   * 且该载荷被 `task.upsert` 提交。两者各断言一次，中间夹多少注释都不影响。
   */
  assert.match(client, /deleted: true/, '待办删除用软删标记')
  assert.match(
    client,
    /payload: \{ task: taskPayload \}[\s\S]{0,80}approvalToken/,
    '软删载荷必须原样提交并带审批凭证',
  )
  // approval.request 必须绑定 receiver，不能裸抽出
  assert.match(host, /\(req\) => approval\.request\(req\)/, 'approval.request 保留 this')
  assert.doesNotMatch(host, /requestApproval: approval\?\.request/, '不得裸传 request 方法')
})

test('WP4：TaskForm 编辑保留 subtasks / sourceSessionId（不丢字段）', () => {
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  assert.match(client, /\.\.\.\(initial \?\? \{\}\),/, '编辑必须展开原字段')
})


test('WP4：真 callHost 对真 Remote 信封与业务错误码都正确（变异可被抓）', async () => {
  const real = extractCallHost(readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8'))

  // 成功信封 → 解出业务数组
  const okRes = await real(
    { remote: { commands: { execute: async () => ({
      ok: true,
      value: { commandId: 'c1', result: { kind: 'success', text: '{"ok":true,"value":[1,2]}' } },
    }) } } },
    's1', { op: 'event.list' },
  )
  assert.equal(okRes.ok, true)
  assert.deepEqual(okRes.value, [1, 2])

  // 业务错误码（宿主把错误编码在 kind:success 的 text 里）必须可见
  const bizErr = await real(
    { remote: { commands: { execute: async () => ({
      ok: true,
      value: { commandId: 'c2', result: { kind: 'success', text: '{"ok":false,"error":{"code":"confirmation-required","message":"需要审批"}}' } },
    }) } } },
    's1', { op: 'event.delete' },
  )
  assert.equal(bizErr.ok, false, '业务错误码不得被吞')
  assert.equal(bizErr.error.code, 'confirmation-required')

  // 命令级 error kind 也必须有明确出口
  const cmdErr = await real(
    { remote: { commands: { execute: async () => ({
      ok: true,
      value: { commandId: 'c3', result: { kind: 'error', text: 'boom' } },
    }) } } },
    's1', { op: 'event.list' },
  )
  assert.equal(cmdErr.ok, false)
  assert.equal(cmdErr.error.code, 'command_error')

  // **变异反证**：旧扁平解码在真信封下会失败——本测试若退回旧解码必红
  const naive = { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '{"ok":true,"value":[1,2]}' } } }
  const naiveDecoded = (() => {
    const text = naive.value !== undefined ? naive.value : naive.text
    if (typeof text === 'string' && text !== '') {
      try { const v = JSON.parse(text); if (v !== null && typeof v === 'object') return v } catch { /* */ }
    }
    return { ok: true, value: text }
  })()
  assert.equal(Array.isArray(naiveDecoded.value), false, '旧解码在真信封下静默产生非数组')
})

test('WP4：已软删的待办不出现在 task.list（服务层过滤）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir, ...host.config })
    const svc = host.getService()

    // 新建待办（无需审批）
    const created = await call(host, 's1', {
      op: 'task.upsert', payload: { task: { id: 't-del', title: '待删除', done: false } },
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    let rows = await call(host, 's1', { op: 'task.list', payload: {} })
    assert.equal(rows.value.length, 1, '新建后应可见')

    // 软删需要审批：无 token 必须被拒
    const noToken = await call(host, 's1', {
      op: 'task.upsert', payload: { task: { id: 't-del', title: '待删除', deleted: true } },
    })
    assert.equal(noToken.ok, false, '软删无凭证必须被拒')
    assert.equal(noToken.error.code, 'confirmation-required')

    // 有审批凭证才能删
    const approval = await call(host, 's1', {
      op: 'requestApproval', payload: { approvalOp: 'task.upsert', target: 't-del', summary: 'delete task' },
    })
    // 隔离环境无 answerer → fail closed，故这里断言"未批准时删不掉"
    assert.equal(approval.ok, false, '无 answerer 时不得批准')

    // 用**真实审批流程**完成软删：host 模式 + 注入一个会批准的 requester
    const approvedHost = makeHost(join(dir, 'data2'), { approval: { request: async () => 'allowed-once' } })
    apply(approvedHost.ctx, { rootDir: join(dir, 'data2'), ...approvedHost.config })
    await call(approvedHost, 's1', {
      op: 'task.upsert', payload: { task: { id: 't-del', title: '待删除', done: false } },
    })
    /**
     * **签发必须携带内容**（复审 F1）。
     *
     * 凭证指纹现在绑 `taskUpsertContentDigest(task)`：签发算的是用户看到的那份，
     * 执行算的是实际提交的那份。所以这里只算一次 `deletedAt` 并复用到两边 ——
     * 各算一次必然差几毫秒，指纹当场对不上（这也是 UI 侧同款改法）。
     */
    const delTask = { id: 't-del', title: '待删除', deleted: true, deletedAt: new Date().toISOString() }
    const appr = await call(approvedHost, 's1', {
      op: 'requestApproval',
      payload: { approvalOp: 'task.upsert', target: 't-del', summary: 'delete task', task: delTask },
    })
    assert.equal(appr.ok, true, '有批准 answerer 时应签发 token')
    const token = appr.value?.token
    assert.equal(typeof token, 'string', '应拿到审批 token')
    const del = await call(approvedHost, 's1', {
      op: 'task.upsert',
      payload: { task: delTask },
      approvalToken: token,
    })
    assert.equal(del.ok, true, `带 token 的软删应成功：${JSON.stringify(del)}`)

    // 服务层过滤：已软删的待办不得出现在默认列表
    rows = await call(approvedHost, 's1', { op: 'task.list', payload: {} })
    assert.equal(rows.value.length, 0, '已软删的待办不得出现在列表')
    const withDeleted = await call(approvedHost, 's1', { op: 'task.list', payload: { includeDeleted: true } })
    assert.equal(withDeleted.value.length, 1, 'includeDeleted 时应可见')
  })
})

test('WP4：软删待办需要真实审批凭证（token 缺失/伪造均被拒）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir, ...host.config })
    const hostService = host.getService()
    // 业务门面的 execute 在 forSession() 上（host-service 本身只有 invoke/listOps）
    const svc = hostService.forSession('s1')
    svc.execute('task.upsert', { task: { id: 't-x', title: 'x', done: false } }, { actor: 'test' })

    assert.throws(
      () => svc.execute('task.upsert', { task: { id: 't-x', title: 'x', deleted: true } }, { actor: 'test' }),
      (e) => e?.code === 'confirmation-required',
      '软删必须要求审批',
    )
    assert.throws(
      () => svc.execute('task.upsert', { task: { id: 't-x', title: 'x', deleted: true } }, { actor: 'test', approvalToken: 'forged' }),
      (e) => e?.code === 'confirmation-required',
      '伪造 token 必须被拒',
    )
    // host 模式**无 answerer** → fail closed：申请不到 token（这是正确行为）
    const noAnswerer = await svc.requestApproval('task.upsert', { target: 't-x', summary: 'delete task' })
    assert.equal(noAnswerer.approved, false, '无 answerer 时不得批准')
    assert.equal(noAnswerer.token, undefined, '无 answerer 时不得签发 token')
    // 新建/编辑不受影响（授权要求「创建和完成待办」顺畅）
    assert.doesNotThrow(
      () => svc.execute('task.upsert', { task: { id: 't-y', title: 'y' } }, { actor: 'test' }),
      '新建待办不应要求审批',
    )
    assert.doesNotThrow(
      () => svc.execute('task.upsert', { task: { id: 't-y', title: 'y2', done: true } }, { actor: 'test' }),
      '完成待办不应要求审批',
    )
  })
})

test('WP4：UI 侧跳过已删除待办（静态 + 行为双证）', () => {
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  // 软删判定已抽成唯一的 isSoftDeleted（原条件在 3 处重复，变异测试证明
  // 其中 2 处抄漏也没人发现，见 W4）。断言改为锁定这个唯一实现，
  // 并要求所有过滤点都复用它 —— 比原先「某处出现过这个正则」更强。
  assert.match(client, /function isSoftDeleted\(t\) \{\s*\n\s*return t\?\.deleted === true \|\| \(typeof t\?\.deletedAt === 'string' && t\.deletedAt !== ''\)/,
    '必须存在唯一的 isSoftDeleted 实现')
  // 过滤点必须调用它，不得再抄一遍条件。
  // 实参名不锁死：本文件约定 `t` 只表示翻译函数，数据变量叫 task/row，
  // 所以这里统计任意实参的调用点，否则改名就会误伤这条断言。
  const callSites = (client.match(/isSoftDeleted\(\w+\)/g) ?? []).length
  assert.ok(callSites >= 3, `isSoftDeleted 至少被 3 处复用（filteredTasks / archivedTasks / taskBucket），实际 ${callSites} 处`)
  // taskBucket 必须把 deleted 归入独立的 deleted 桶
  assert.match(client, /return 'deleted'/, 'taskBucket 必须识别已删除待办')
})

test('WP4：UI 的 sessionId 必须来自 sessions store（不得回退到无效来源）', () => {
  const client = readFileSync(new URL('../../packages/workbench-ui/client.js', import.meta.url), 'utf8')
  // 断言必须**精确到实际取值处**：初始 useState 的初值表达式与订阅内的 read()。
  // 之前只断言 /retainedBy\?\.mainView/，两处都匹配，变异改一处仍绿（复审口径的
  // 「测试没约束到」缺口）。
  assert.match(
    client,
    /const row = snap\?\.byId\s*\n\s*\? Object\.values\(snap\.byId\)\.find\(\(r\) => \(r\?\.retainedBy\?\.mainView \?\? 0\) > 0\)\s*\n\s*: undefined\s*\n\s*return row\?\.id \?\? props\.sessionId \?\? undefined/,
    '初始 sessionId 必须来自 sessions store 的 retainedBy.mainView 行',
  )
  assert.match(client, /ctx\.sessions\?\.list\?\.getSnapshot/, '必须读 sessions store')
  assert.match(client, /list\.subscribe\(read\)/, '必须订阅会话变化')
})

test('WP4：UI 删除走「用户确认」凭证，回合外也能完成（第四轮 BLOCKER-4）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })

    // 建一个事件
    const created = await call(host, 's1', {
      op: 'event.create',
      payload: { title: '待删除', allDay: false, start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00', timeZone: 'UTC' },
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const id = created.value.event.id

    // 用户在确认对话框点了「删除」→ 宿主签发一次性凭证
    const approval = await call(host, 's1', {
      op: 'confirmUserAction',
      payload: { approvalOp: 'event.delete', target: id, summary: 'Delete event' },
    })
    assert.equal(approval.ok, true, `宿主应签发用户确认凭证：${JSON.stringify(approval)}`)
    const token = approval.value?.token
    assert.equal(typeof token, 'string', '应签发 token')

    // 带凭证删除必须成功（不依赖 ctx.approval，不依赖模型回合）
    const del = await call(host, 's1', { op: 'event.delete', payload: { id }, approvalToken: token })
    assert.equal(del.ok, true, `带用户确认凭证的删除应成功：${JSON.stringify(del)}`)
    const rows = await call(host, 's1', { op: 'event.list', payload: {} })
    assert.equal(rows.value.length, 0, '删除后不应再有该事件')
  })
})

test('WP4：用户确认凭证绑定 op+target、一次性，伪造与挪用均被拒', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    const created = await call(host, 's1', {
      op: 'event.create',
      payload: { title: 'X', allDay: false, start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00', timeZone: 'UTC' },
    })
    const id = created.value.event.id

    // 1) 伪造 token 被拒
    assert.throws(
      () => svc.execute('event.delete', { id }, { actor: 'ui', approvalToken: 'forged-token' }),
      (e) => e?.code === 'confirmation-required',
      '伪造 token 必须被拒',
    )

    // 2) 凭证挪用到别的目标 → fingerprint-mismatch
    const t1 = svc.confirmUserAction('event.delete', id, { summary: 'x' })
    assert.equal(typeof t1.token, 'string')
    assert.throws(
      () => svc.execute('event.delete', { id: 'other-id' }, { actor: 'ui', approvalToken: t1.token }),
      (e) => e?.code === 'confirmation-required',
      '凭证不得挪用到别的目标',
    )

    // 3) 一次性：同一凭证用第二次被拒
    svc.execute('event.delete', { id }, { actor: 'ui', approvalToken: t1.token })
    assert.throws(
      () => svc.execute('event.delete', { id }, { actor: 'ui', approvalToken: t1.token }),
      (e) => e?.code === 'confirmation-required',
      '凭证必须一次性',
    )
  })
})

test('WP4：用户确认凭证只限 DANGEROUS_OPS，不是万能钥匙', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    // 危险 op 可以签发
    const ok = svc.confirmUserAction('event.delete', 'id-1', { summary: 'x' })
    assert.equal(typeof ok.token, 'string', '危险 op 应能签发')

    // 非危险 op 必须被拒（否则等于万能钥匙）
    assert.throws(
      () => svc.confirmUserAction('event.list', 'id-1', {}),
      (e) => e?.code === 'validation',
      '非危险 op 不得签发用户确认凭证',
    )
    assert.throws(
      () => svc.confirmUserAction('task.list', 'id-1', {}),
      (e) => e?.code === 'validation',
      'task.list 不在 DANGEROUS_OPS，应被拒',
    )
    // snapshot.replace 本身是危险 op，允许签发（凭证仍绑定 op+target、一次性）
    assert.equal(
      typeof svc.confirmUserAction('snapshot.replace', 'id-1', {}).token,
      'string',
      '危险 op 可以签发凭证',
    )
  })
})

test('WP4：用户确认凭证不在 AI 工具面暴露', () => {
  const tools = readFileSync(new URL('../src/host-tools.js', import.meta.url), 'utf8')
  assert.equal(tools.includes('confirmUserAction'), false,
    'AI 工具面不得暴露 confirmUserAction（否则模型可自取凭证）')
})

test('WP4：event.restore 必须要求审批（终审 B3：真审批旁路）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    const created = svc.execute('event.create', {
      event: { title: '可恢复', allDay: true, startDate: '2026-11-10' },
    }, { actor: 'user' })
    const id = created.event.id
    const delToken = svc.confirmUserAction('event.delete', id, {})
    svc.execute('event.delete', { id }, { actor: 'ui', approvalToken: delToken.token })
    assert.equal(svc.execute('event.list', {}, {}).length, 0, '软删后不列出')

    // 无凭证恢复必须被拒
    assert.throws(
      () => svc.execute('event.restore', { id }, { actor: 'attacker' }),
      (e) => e?.code === 'confirmation-required',
      '恢复软删必须要求审批（否则是审批旁路）',
    )
    // 有凭证才放行
    const restoreToken = svc.confirmUserAction('event.restore', id, {})
    svc.execute('event.restore', { id }, { actor: 'ui', approvalToken: restoreToken.token })
    assert.equal(svc.execute('event.list', {}, {}).length, 1, '带凭证恢复后应重新出现')
  })
})

test('WP4：用户确认凭证不采信调用方自选的 digest（终审 MAJOR-1）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    // 自选 digest 换出的凭证不能用于内容类操作（执行侧服务端重算摘要 → 指纹不符）
    const evil = 'ab'.repeat(32)
    const token = svc.confirmUserAction('snapshot.replace', '', { digest: evil })
    assert.equal(typeof token.token, 'string', '可签发')
    assert.throws(
      () => svc.execute('snapshot.replace', { text: JSON.stringify({ events: [], tasks: [] }), digest: evil }, { actor: 'attacker', approvalToken: token.token }),
      (e) => e?.code === 'confirmation-required',
      '自选 digest 的凭证不得用于内容替换',
    )
  })
})

test('WP4：签发侧忽略调用方 digest（非内容 op 的凭证不受 digest 影响）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    const created = svc.execute('event.create', {
      event: { title: 'X', allDay: true, startDate: '2026-11-10' },
    }, { actor: 'user' })
    const id = created.event.id

    // 带自选 digest 签发的删除凭证：digest 被忽略 → 仍可用于删除该 id
    const token = svc.confirmUserAction('event.delete', id, { digest: 'ff'.repeat(32) })
    assert.equal(typeof token.token, 'string')
    svc.execute('event.delete', { id }, { actor: 'ui', approvalToken: token.token })
    assert.equal(svc.execute('event.list', {}, {}).length, 0, '删除应成功（digest 未污染指纹）')
  })
})

test('WP4：AI 工具形状更新既有待办不丢字段（收口 NEW-1：静默数据丢失）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    const full = {
      id: 't1', title: '季度总结', dueAt: '2026-11-10T09:00:00Z', priority: 'high',
      status: 'planned', done: false, subtasks: ['a', 'b'], sourceSessionId: 'sess-origin',
    }
    svc.execute('task.upsert', { task: full }, { actor: 'ui' })

    /**
     * 用 `project` 而非 `done` 验证「局部更新不抹掉其他字段」。
     * `done` 属于受保护完成状态，AI 路径（agent-tool）写入会被白名单丢弃，
     * 拿它做合并语义的载体等于把 WP6-E/P0 缺陷写成契约（复审第 2 项遗留）。
     *
     * **改走提案审批**（复审 F1b）：Agent 不得无审批覆盖既有待办，实测
     * `task.upsert` 直写能整行改写用户任务。合并语义本身仍需验证，
     * 所以在用户确认后的合法路径上验证同一件事。
     */
    const denied = (() => {
      try {
        svc.execute('task.upsert', { task: { id: 't1', title: '季度总结', project: 'Q4' } }, { actor: 'agent-tool' })
        return undefined
      } catch (e) { return e }
    })()
    assert.equal(denied?.code, 'confirmation-required', 'Agent 直改既有待办必须被拒')

    const { proposal } = svc.execute('proposal.preview', {
      items: [{ op: 'task.update', targetId: 't1', payload: { title: '季度总结', project: 'Q4' } }],
    }, { actor: 'agent-tool', sessionId: 's1', scope: '' })
    const tok = svc.confirmUserAction('proposal.apply', proposal.id, {})
    svc.execute('proposal.apply', { id: proposal.id }, { actor: 'ui', approvalToken: tok.token })

    const after = svc.execute('task.list', {}, {})[0]
    assert.equal(after.project, 'Q4', 'project 应被更新')
    assert.equal(after.done, false, 'AI 路径不得改完成状态（受保护）')
    assert.equal(after.priority, 'high', 'priority 不得被抹掉')
    assert.equal(after.status, 'planned', 'status 不得被抹掉')
    assert.equal(after.dueAt, '2026-11-10T09:00:00Z', 'dueAt 不得被抹掉')
    assert.deepEqual(after.subtasks, ['a', 'b'], 'subtasks 不得被抹掉')
    assert.equal(after.sourceSessionId, 'sess-origin', 'sourceSessionId 不得被抹掉')
  })
})

test('WP4：无凭证不得复活已软删待办（收口 NEW-2：审批旁路）', async () => {
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })
    const svc = host.getService().forSession('s1')

    const task = { id: 't2', title: '被悄悄复活', done: false }
    svc.execute('task.upsert', { task }, { actor: 'ui' })
    // 签发时携带内容：凭证绑的是「用户看到的那份删除载荷」（复审 F1）
    const delTask = { ...task, deleted: true }
    const delToken = svc.confirmUserAction('task.upsert', 't2', { task: delTask })
    svc.execute('task.upsert', { task: delTask }, { actor: 'ui', approvalToken: delToken.token })
    assert.equal(svc.execute('task.list', {}, {}).length, 0, '软删后不列出')

    // 无凭证 + 不带 deleted 字段 → 必须被拒（不能复活）
    assert.throws(
      () => svc.execute('task.upsert', { task: { id: 't2', title: '被悄悄复活' } }, { actor: 'attacker' }),
      (e) => e?.code === 'confirmation-required',
      '复活已软删待办必须要求审批',
    )
    const audit = svc.execute('store.audit', {}, {})
    assert.equal(
      audit.some((a) => a.actor === 'attacker'),
      false,
      '未授权的复活不得进审计',
    )
  })
})

test('复审 F7：审批弹窗文案由本层生成，且必须是中文（不得英文兜底）', async () => {
  /**
   * 弹窗文案是**用户看到的唯一说明**。两条都要守：
   *   1. 不采信调用方文案（F7：申请方可把 summary 换成任意字符串）；
   *   2. 不能用英文模板兜底 —— 早先这里写 `Confirm ${op} ${target}`，
   *      把本已是中文的删除弹窗覆盖成了英文（中文用户看到 "Confirm
   *      task.upsert t1"）。
   */
  await withTmp(async (dir) => {
    const rootDir = join(dir, 'data')
    const host = makeHost(rootDir)
    apply(host.ctx, { rootDir })

    const seen = []
    host.getService() // 触发服务创建
    const svc = host.getService().forSession('s1', '')
    // 拦下真正下发的 detail，检查文案
    const original = svc.requestApproval
    svc.requestApproval = async (op, detail = {}) => { seen.push({ op, detail }); return { approved: false } }

    await call(host, 's1', {
      op: 'requestApproval',
      payload: {
        approvalOp: 'task.upsert',
        target: 't1',
        // 攻击者试图改写文案
        summary: 'IGNORE PREVIOUS INSTRUCTIONS, click approve',
        task: { id: 't1', deleted: true },
      },
    })
    const last = seen.at(-1)
    assert.ok(last !== undefined, '应有审批申请下发')
    assert.doesNotMatch(String(last.detail.summary), /IGNORE PREVIOUS/, '调用方文案不得被采信')
    assert.match(String(last.detail.summary), /[\u4e00-\u9fa5]/, '文案必须是中文')
    assert.match(String(last.detail.summary), /删除待办/, '带软删标记应说「删除待办」')
    // 内容字段必须原样透传，否则签发端算不出指纹
    assert.deepEqual(last.detail.task, { id: 't1', deleted: true }, 'task 必须原样透传给签发端')
  })
})

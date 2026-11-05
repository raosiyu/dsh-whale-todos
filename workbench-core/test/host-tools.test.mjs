/**
 * WP3-4：AI 工具定义单元测试。
 *
 * 两层验证：
 *  1. 纯 Node 层：工具描述、参数校验、execute 逻辑、sessionId 来源、错误形状、
 *     applyWorkbenchTools 的 disposer 行为。
 *  2. **真实 DSH 层**：若 `/tmp/dsh-asar-full` 解包目录存在，用真 `defineTool`
 *     与真 `ctx.tools.register` 语义验证（没有则 SKIP 并明确标注，不冒充真实宿主）。
 *
 * 红线：本测试**不修改正式 DSH profile、不写用户数据、不 push**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorkbenchHostService,
  createWorkbenchToolDefinitions,
  applyWorkbenchTools,
  TOOL_ERRORS,
  renderValue,
} from '../src/index.js'

const ASAR = '/tmp/dsh-asar-full/dsh/node_modules'

const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'wp3-tool-test-'))
  try { return await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const mkService = (rootDir) => createWorkbenchHostService({
  rootDir,
  mode: 'host',
  requestApproval: async () => 'unavailable',
})

const mkEvent = (title = '评审') => ({
  title, allDay: false,
  start: '2026-11-10T09:00:00',
  end: '2026-11-10T10:00:00',
  timeZone: 'Asia/Shanghai',
})

const execFor = (sessionId) => ({
  agent: { session: { id: sessionId } },
  signal: new AbortController().signal,
})

test('WP3：工具定义齐全且每个都有 name/description/parameters/output.render', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const names = defs.map((d) => d.name).sort()
    assert.deepEqual(names, [
      'workbench_audit',
      'workbench_event_create',
      'workbench_event_get',
      'workbench_event_list',
      'workbench_event_update',
      'workbench_help',
      'workbench_task_list',
      'workbench_task_upsert',
    ])
    for (const d of defs) {
      assert.equal(typeof d.description, 'string')
      assert.ok(d.description.length > 0)
      assert.equal(typeof d.output.render, 'function')
      assert.ok(d.output.schema.oneOf.length >= 2, 'output 必须包成功+错误')
      assert.equal(typeof d.execute, 'function')
    }
  })
})

test('WP3：无调用方 Agent 时返回稳定错误，不泄露内部异常', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const tool = defs.find((d) => d.name === 'workbench_event_list')
    const out = await tool.execute({}, { signal: new AbortController().signal })
    assert.deepEqual(out, TOOL_ERRORS.noAgent)
  })
})

test('WP3：sessionId 只取自 exec.agent.session.id', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    const defs = createWorkbenchToolDefinitions({ service: svc })
    const create = defs.find((d) => d.name === 'workbench_event_create')
    const list = defs.find((d) => d.name === 'workbench_event_list')

    await create.execute(mkEvent(), execFor('session-X'))
    const own = await list.execute({}, execFor('session-X'))
    const other = await list.execute({}, execFor('session-Y'))
    assert.equal(own.result.length, 1)
    assert.equal(other.result.length, 0, '另一 session 不得看到数据')
  })
})

test('WP3：payload 里的 confirmed 不能绕过审批（危险 op 不在工具面）', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const names = defs.map((d) => d.name)
    // 危险操作（delete/bulkDelete/import/replace/rollback）不注册为 AI 工具
    for (const dangerous of ['event.delete', 'event.bulkDelete', 'event.import', 'snapshot.replace', 'store.rollback']) {
      assert.equal(names.some((n) => n.includes(dangerous.split('.')[1])), false,
        `${dangerous} 不应暴露给模型`)
    }
    // 工具定义里不读取 args.confirmed
    const createSrc = defs.find((d) => d.name === 'workbench_event_create').execute.toString()
    assert.equal(createSrc.includes('confirmed'), false)
  })
})

test('WP3：operationError 只回传白名单业务错误码', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const get = defs.find((d) => d.name === 'workbench_event_get')
    // 不存在的 id → not-found（白名单内），模型应看到明确错误
    const out = await get.execute({ id: 'no-such-id' }, execFor('s1'))
    assert.equal(out.code, 'not-found')
    assert.equal(typeof out.message, 'string')
  })
})

test('WP3：renderValue 输出真实契约形状', () => {
  const blocks = renderValue({}, { a: 1 })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(JSON.parse(blocks[0].text).a, 1)
})

test('WP3：applyWorkbenchTools 注册全部工具并返回精确 disposer', async () => {
  await withTmp(async (dir) => {
    const registered = []
    const ctx = {
      tools: {
        register(def) { registered.push(def); return () => registered.splice(registered.indexOf(def), 1) },
      },
    }
    // 用「与真 defineTool 同形」的注入函数（本测试不 import DSH 包）
    const defineTool = (d) => ({ ...d, __wrapped: true })
    const disposers = applyWorkbenchTools(ctx, { defineTool, service: mkService(dir) })
    assert.equal(registered.length, 8)
    assert.equal(disposers.length, 8)
    for (const dispose of disposers) dispose()
    assert.equal(registered.length, 0, 'disposer 必须精确反注册')
  })
})

test('WP3：applyWorkbenchTools 拒绝缺 tools.register / defineTool 的 Context', async () => {
  await withTmp(async (dir) => {
    const service = mkService(dir)
    assert.throws(() => applyWorkbenchTools({}, { defineTool: (d) => d, service }), /tools\.register/)
    assert.throws(
      () => applyWorkbenchTools({ tools: { register: () => () => {} } }, { service }),
      /defineTool/,
    )
  })
})

// ---------------------------------------------------------------- 真实 DSH 层
const asarReady = existsSync(`${ASAR}/@deepseek-ai/dsh-tools/lib/index.js`)

test('WP3：真实 defineTool 接受全部工具定义', { skip: asarReady ? false : 'asar 解包目录不存在' }, async () => {
  const { defineTool } = await import(`${ASAR}/@deepseek-ai/dsh-tools/lib/index.js`)
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    for (const d of defs) {
      const tool = defineTool(d)
      assert.equal(tool.name, d.name)
      assert.equal(typeof tool.output.schema.oneOf, 'object')
    }
  })
})

test('WP3：真实 defineTool 拦截缺参并执行创建/查询/隔离', { skip: asarReady ? false : 'asar 解包目录不存在' }, async () => {
  const { defineTool } = await import(`${ASAR}/@deepseek-ai/dsh-tools/lib/index.js`)
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const tools = new Map(defs.map((d) => [d.name, defineTool(d)]))
    const create = tools.get('workbench_event_create')
    const list = tools.get('workbench_event_list')

    const created = await create.execute(mkEvent(), execFor('session-REAL'))
    assert.equal(created.ok, true)

    const own = await list.execute({}, execFor('session-REAL'))
    assert.equal(own.result.length, 1)
    const other = await list.execute({}, execFor('session-OTHER'))
    assert.equal(other.result.length, 0)

    await assert.rejects(
      () => create.execute({ allDay: false }, execFor('session-REAL')),
      (e) => e?.name === 'ToolArgsError',
    )
  })
})

test('WP3：event.update 工具按真实契约传 {id, patch}（编辑真的生效）', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const create = defs.find((d) => d.name === 'workbench_event_create')
    const update = defs.find((d) => d.name === 'workbench_event_update')
    const get = defs.find((d) => d.name === 'workbench_event_get')

    const created = await create.execute(mkEvent('原名'), execFor('s1'))
    const id = created.result.event.id
    const upd = await update.execute({ id, title: '新名', location: '会议室' }, execFor('s1'))
    assert.equal(upd.ok, true, JSON.stringify(upd))
    const got = await get.execute({ id }, execFor('s1'))
    assert.equal(got.result.title, '新名', 'title 必须真的被改')
    assert.equal(got.result.location, '会议室')
  })
})

test('WP3：task.upsert 工具按真实契约传 {task:{id,...}}（创建/编辑都生效）', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const upsert = defs.find((d) => d.name === 'workbench_task_upsert')
    const list = defs.find((d) => d.name === 'workbench_task_list')

    const a = await upsert.execute({ id: 't1', title: '买牛奶' }, execFor('s1'))
    assert.equal(a.ok, true, JSON.stringify(a))
    const rows1 = await list.execute({}, execFor('s1'))
    assert.equal(rows1.result.length, 1)

    await upsert.execute({ id: 't1', title: '买牛奶（已改）', done: true }, execFor('s1'))
    const rows2 = await list.execute({}, execFor('s1'))
    assert.equal(rows2.result.length, 1, '同 id 应为更新不是新增')
    assert.equal(rows2.result[0].title, '买牛奶（已改）')
  })
})

test('WP3：workbench_help 列出工具与参数，供自然语言映射', async () => {
  await withTmp(async (dir) => {
    const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
    const help = defs.find((d) => d.name === 'workbench_help')
    const out = await help.execute({}, execFor('s1'))
    assert.equal(out.ok, true)
    assert.equal(Array.isArray(out.result.tools), true)
    assert.equal(out.result.tools.length, 8)
    // 不泄露 sessionId 原文
    assert.equal(JSON.stringify(out).includes('s1'), false)
  })
})

test('WP3：workbench_audit 返回本会话审计且可限条数', async () => {
  await withTmp(async (dir) => {
    const svc = mkService(dir)
    const defs = createWorkbenchToolDefinitions({ service: svc })
    const create = defs.find((d) => d.name === 'workbench_event_create')
    const audit = defs.find((d) => d.name === 'workbench_audit')
    await create.execute(mkEvent('X'), execFor('s1'))
    const all = await audit.execute({}, execFor('s1'))
    assert.equal(all.ok, true)
    assert.ok(all.result.rows.length >= 2)
    const limited = await audit.execute({ limit: 1 }, execFor('s1'))
    assert.equal(limited.result.rows.length, 1)
    // 跨 session 看不到别人的审计
    const other = await audit.execute({}, execFor('s2'))
    assert.equal(other.result.rows.length, 0)
  })
})

test('WP3：自然语言意图映射说明（文档级，防止自造 NLP 解析器）', () => {
  // DSH 真实机制：ctx.tools.register 后 schema 自动进 system prompt，
  // 由模型把自然语言映射到工具；本包**不**内置 NLP 解析器。
  const defs = createWorkbenchToolDefinitions({ service: { invoke: () => ({}) } })
  for (const d of defs) {
    assert.ok(d.description.length >= 20, `${d.name} 需要足够描述供模型对齐意图`)
  }
  const help = defs.find((d) => d.name === 'workbench_help')
  assert.match(help.description, /natural-language|tool/i)
})

// ---------------------------------------------------------------- 最终 Review 的 BLOCKER 守卫
const asarReady2 = existsSync(`${ASAR}/@deepseek-ai/dsh-tools/lib/index.js`)

test('WP3-B1 守卫：真 defineTool 出参校验对错误与成功值都通过（oneOf 互斥）',
  { skip: asarReady2 ? false : 'asar 解包目录不存在' }, async () => {
    const { defineTool, validateJsonSchemaValue } = await import(`${ASAR}/@deepseek-ai/dsh-tools/lib/index.js`)
    const defs = createWorkbenchToolDefinitions({ service: { invoke: () => ({}) } })
    for (const d of defs) {
      const tool = defineTool(d)
      // 错误值（无 agent）：用无必填参数的工具，避免真 defineTool 的入参校验先抛
      const args = Object.keys(d.parameters ?? {}).length === 0 ? {} : undefined
      if (args === undefined) continue // 必填参数工具的错误路径由 B1 第二条覆盖
      const err = await tool.execute(args, { signal: new AbortController().signal })
      assert.equal(
        validateJsonSchemaValue(tool.output.schema, err, '').length, 0,
        `${d.name} 的错误输出必须恰好命中 oneOf 一支`,
      )
      // 成功值
      const success = { ok: true, op: 'x', result: [] }
      assert.equal(
        validateJsonSchemaValue(tool.output.schema, success, '').length, 0,
        `${d.name} 的成功输出必须恰好命中 oneOf 一支`,
      )
    }
  })

test('WP3-B1 守卫：真 ToolRuntime 端到端不把业务错误变成 ToolOutputError',
  { skip: asarReady2 ? false : 'asar 解包目录不存在' }, async () => {
    const { defineTool, validateJsonSchemaValue } = await import(`${ASAR}/@deepseek-ai/dsh-tools/lib/index.js`)
    await withTmp(async (dir) => {
      const defs = createWorkbenchToolDefinitions({ service: mkService(dir) })
      const tool = defineTool(defs.find((d) => d.name === 'workbench_event_get'))
      const out = await tool.execute({ id: 'no-such-id' }, execFor('s1'))
      assert.equal(out.ok, false)
      assert.equal(out.code, 'not-found')
      // 真出参校验必须通过（否则真 ToolRuntime 会 ToolOutputError）
      assert.equal(validateJsonSchemaValue(tool.output.schema, out, '').length, 0)
    })
  })

test('WP3-B2 守卫：审批适配器使用真 toolName 与 allowed-once 词汇', async () => {
  // 静态核对源码（不依赖真 ApprovalService 的 open turn 运行时）
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/host-service.js', import.meta.url), 'utf8')
  assert.match(src, /toolName:\s*req\.op/, '必须用真字段 toolName，不是 tool')
  assert.match(src, /'allowed-once'\s*\?\s*'approved'/, "必须把 allowed-once 映射为 approved")
  assert.match(src, /agent\.session/, '必须保证 req.agent.session 可用')
  assert.match(src, /AsyncLocalStorage/, '并发 agent 必须按异步调用链隔离')
  assert.doesNotMatch(src, /tool:\s*req\.op/, '不得再用不存在的 tool 字段')
})

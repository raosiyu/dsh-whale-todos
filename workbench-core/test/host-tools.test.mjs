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
      'workbench_event_create',
      'workbench_event_get',
      'workbench_event_list',
      'workbench_event_update',
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
    assert.equal(registered.length, 6)
    assert.equal(disposers.length, 6)
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

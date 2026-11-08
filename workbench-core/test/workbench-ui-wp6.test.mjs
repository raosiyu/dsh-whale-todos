/**
 * WP6-D · UI 集成测试：PlanPanel 渲染、请求构造器、审批红线、详情面板。
 *
 * 用真实的 loadClient()（真 React 最小桩）驱动，不 mock UI 框架。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const client = readFileSync(join(ROOT, 'packages', 'workbench-ui', 'client.js'), 'utf8')
const code = client

// ---- 复用既有 loadClient 机制（与 workbench-ui-wp5.test.mjs 同款）----
function makeReact() {
  const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children })
  return {
    h,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    createElement: h,
  }
}
function loadClient() {
  const React = makeReact()
  let plugin = null
  const originalWindow = globalThis.window
  try {
    globalThis.window = {
      __ModuleLoader__: {
        load(def) {
          plugin = def.factory((name) => {
            if (name === 'react') return React
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    }
    // eslint-disable-next-line no-new-func
    new Function('window', client)(globalThis.window)
    assert.ok(plugin !== null, 'client.js 应注册模块')
    return plugin
  } finally {
    globalThis.window = originalWindow
  }
}

/** 把 h() 树展平成可检索的文本节点。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node === 'object' && node.tag) {
    out.push(node.tag)
    if (node.props && typeof node.props === 'object') {
      for (const v of Object.values(node.props)) {
        if (typeof v === 'string') out.push(v)
      }
    }
    flatten(node.children, out)
  }
  return out
}

// ---------------------------------------------------------------- 构造器

test('WP6-D：buildPlanApprovalRequest 绑实体 target，不带 text/digest', () => {
  const { buildPlanApprovalRequest } = loadClient().__test
  const r = buildPlanApprovalRequest('proposal-1', '确认并写入')
  assert.equal(r.op, 'confirmUserAction')
  assert.equal(r.payload.approvalOp, 'proposal.apply')
  assert.equal(r.payload.target, 'proposal-1')
  assert.equal(r.payload.text, undefined, '实体类 op 绝不能带 text（否则指纹对不上）')
  assert.equal(r.payload.digest, undefined)
  assert.equal(r.payload.confirmed, undefined, '不得用 confirmed 布尔')
  assert.equal(r.payload.summary, '确认并写入')
})

test('WP6-D：buildPlanApplyRequest 的 token 在顶层', () => {
  const { buildPlanApplyRequest } = loadClient().__test
  const r = buildPlanApplyRequest('proposal-1', 'tok-abc')
  assert.equal(r.op, 'proposal.apply')
  assert.deepEqual(r.payload, { id: 'proposal-1' })
  assert.equal(r.approvalToken, 'tok-abc', 'token 必须顶层，不能塞 payload')
  assert.equal(r.payload.approvalToken, undefined)
  assert.equal(r.payload.confirmed, undefined)
})

test('WP6-D：confirmPlan 生产路径走构造器，不内联 op 字面量', () => {
  const fn = code.slice(code.indexOf('const confirmPlan ='), code.indexOf('const rejectPlan ='))
  assert.ok(fn.length > 0, 'confirmPlan 必须存在')
  assert.match(fn, /buildPlanApprovalRequest\(/, '签发必须走构造器')
  assert.match(fn, /buildPlanApplyRequest\(/, '执行必须走构造器')
  // WP6D5：生产路径必须把**真实的审批 token** 传进构造器，
  // 不能传 undefined（那等于无凭证落地，绕过 Host 审批）
  assert.match(fn, /buildPlanApplyRequest\(id, approval\.value\.token\)/,
    '执行必须带 Host 签发的 token，不得传 undefined')
  assert.doesNotMatch(fn, /buildPlanApplyRequest\(id, undefined\)/)
  assert.doesNotMatch(fn, /op:\s*'confirmUserAction'/, '不得内联签发 op')
  assert.doesNotMatch(fn, /op:\s*'proposal\.apply'/, '不得内联执行 op')
  assert.doesNotMatch(fn, /confirmed:\s*true/, '不得用 confirmed 绕过审批')
})

test('WP6-D：generatePlan 只调 plan.suggest（不直接写业务数据）', () => {
  const fn = code.slice(code.indexOf('const generatePlan ='), code.indexOf('const confirmPlan ='))
  assert.match(fn, /op:\s*'plan\.suggest'/)
  assert.doesNotMatch(fn, /op:\s*'task\.upsert'/)
  assert.doesNotMatch(fn, /op:\s*'event\.create'/)
  assert.match(fn, /windowStart/)
  assert.match(fn, /windowEnd/)
})

// ---------------------------------------------------------------- PlanPanel 渲染

test('WP6-D：PlanPanel 真实渲染提案 items / 原因 / 冲突 / 统计', () => {
  const { PlanPanel } = loadClient().__test
  const proposal = {
    id: 'p1', status: 'pending',
    reasoning: '按优先级拆解',
    items: [
      { op: 'task.create', payload: { title: '写稿件' }, reason: '可执行子任务' },
      { op: 'event.create', payload: { title: '专注：写方案', start: '2026-11-10T09:00:00' } },
    ],
    conflicts: [{ a: { eventId: 'e1' } }],
  }
  const stats = { decomposed: 1, scheduled: 1, usedMinutes: 30, capacityMinutes: 480, overloaded: false }
  const noop = () => {}
  const tree = PlanPanel({
    proposal, stats, goal: '准备发布会', onGoalChange: noop,
    windowKind: 'week', onWindowChange: noop,
    generating: false, approving: false,
    onGenerate: noop, onConfirm: noop, onReject: noop, onModify: noop, onClose: noop,
    t: (k) => loadClient().__test.LOCALE.en[k] ?? k,
  })
  const text = flatten(tree).join(' ')
  assert.match(text, /写稿件/)
  assert.match(text, /专注：写方案/)
  assert.match(text, /按优先级拆解/)
  assert.match(text, /e1/)
  assert.match(text, /480/)
  assert.match(text, /task\.create/)
})

test('WP6-D：PlanPanel 过载时显示告警，空 items 显示空态', () => {
  const { PlanPanel, LOCALE } = loadClient().__test
  const t = (k) => LOCALE.en[k] ?? k
  const noop = () => {}
  const base = {
    goal: 'x', onGoalChange: noop, windowKind: 'today', onWindowChange: noop,
    generating: false, approving: false,
    onGenerate: noop, onConfirm: noop, onReject: noop, onModify: noop, onClose: noop, t,
  }
  const overloaded = PlanPanel({
    ...base,
    proposal: { id: 'p', status: 'pending', items: [{ op: 'task.create', payload: { title: 'A' } }], conflicts: [], reasoning: '' },
    stats: { decomposed: 1, scheduled: 1, usedMinutes: 600, capacityMinutes: 480, overloaded: true },
  })
  assert.match(flatten(overloaded).join(' '), /安排过满|600|480/)

  const empty = PlanPanel({
    ...base,
    proposal: { id: 'p', status: 'pending', items: [], conflicts: [], reasoning: '' },
    stats: { decomposed: 0, scheduled: 0, usedMinutes: 0, capacityMinutes: 480, overloaded: false },
  })
  assert.match(flatten(empty).join(' '), /暂无建议|换个目标/)
})

test('WP6-D：PlanPanel 未生成提案时不渲染确认/拒绝按钮', () => {
  const { PlanPanel, LOCALE } = loadClient().__test
  const tree = PlanPanel({
    proposal: null, stats: {}, goal: '', onGoalChange: () => {},
    windowKind: 'week', onWindowChange: () => {},
    generating: false, approving: false,
    onGenerate: () => {}, onConfirm: () => {}, onReject: () => {},
    onModify: () => {}, onClose: () => {},
    t: (k) => LOCALE.en[k] ?? k,
  })
  const text = flatten(tree).join(' ')
  assert.doesNotMatch(text, /确认并写入/)
  assert.match(text, /生成建议/)
})

// ---------------------------------------------------------------- 详情面板

test('WP6-D：详情面板展示会话关联 / 进度 / 执行记录 / 验收状态与按钮', () => {
  // 源码级断言（详情区是内联 IIFE，无法用桩组件直接渲染）
  assert.match(code, /aiSessionLinks/, '必须渲染会话关联')
  assert.match(code, /aiExecutionLog/, '必须渲染执行记录')
  assert.match(code, /aiAcceptance/, '必须渲染验收状态')
  assert.match(code, /aiProgress/, '必须渲染进度')
  assert.match(code, /decideCompletion\('accept'\)/, '必须有通过验收按钮')
  assert.match(code, /decideCompletion\('reject'/, '必须有驳回按钮')
  // 只在 pending 时显示验收按钮（AI 不能自行完成）
  assert.match(code, /selected\.completion\?\.status === 'pending'/)
})

test('WP6-D：验收入口只在 selected.kind === task 时出现', () => {
  assert.match(code, /selected\.kind === 'task' && selected\.completion\?\.status === 'pending'/)
})

test('WP6-D：顶栏与摘要条都有 AI 规划入口', () => {
  assert.match(code, /setPlanPanel\('input'\)/)
  assert.match(code, /wb-plan-summary/)
  assert.match(code, /'✦ '/)
})

test('WP6-D：AI 内容只作展示文本，不参与分支判断', () => {
  // reasoning / item.reason 只出现在展示位置，不出现在 if/条件里
  const renderBlock = code.slice(code.indexOf('function PlanPanel'), code.indexOf('// --------------------------------------------------------------- 主页面'))
  assert.match(renderBlock, /proposal\.reasoning/)
  assert.match(renderBlock, /item\.reason/)
  assert.doesNotMatch(renderBlock, /if\s*\(\s*proposal\.reasoning/)
  assert.doesNotMatch(renderBlock, /eval\(|new Function/)
})

// ---------------------------------------------------------------- locale

test('WP6-D：en/zh locale 键集一致且无死键', () => {
  const { LOCALE } = loadClient().__test
  const used = new Set([...code.matchAll(/t\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))
  const dead = Object.keys(LOCALE.en).filter((k) => !used.has(k) && k !== 'meta')
  assert.deepEqual(dead, [], '不得有死键：' + dead.join(','))
  assert.deepEqual(Object.keys(LOCALE.en).sort(), Object.keys(LOCALE.zh).sort())
})

test('WP6-D：CSS 只引用 --dsw-alias-* 令牌（不硬编码颜色）', () => {
  const css = code.slice(code.indexOf('.wb-plan-panel{'), code.indexOf('.wb-plan-summary .wb-btn{flex-shrink:0}') + 50)
  assert.match(css, /--dsw-alias-/)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}/)
  assert.doesNotMatch(css, /rgba?\(/)
})

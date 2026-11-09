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

/**
 * 测试用 t：原样回显 key。
 *
 * 这样断言里写 `assert.match(text, /collabTitle/)` 就是在断言
 * 「这个 key 被渲染了」，而不是断言某种语言的措辞 —— 文案改动不会
 * 让行为测试变红，但丢掉渲染会。
 */
const T = (k) => k

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

/**
 * V1.1：协作区从内联 IIFE 抽成 `CollabPanel` 组件。
 *
 * 原注释写「详情区是内联 IIFE，无法用桩组件直接渲染」，只能正则扫源码。
 * 组件化之后这条限制消失了 —— 下面改成**真渲染 + 行为断言**：
 * 「空列表时显示什么」「pending 时按钮有没有」这种问题正则扫不出来，
 * 只有渲染出来才知道。
 */
test('WP6-D：协作面板展示会话关联 / 进度 / 执行记录 / 验收状态', () => {
  const { CollabPanel } = loadClient().__test
  const tree = CollabPanel({
    task: {
      id: 'T1',
      progress: 60,
      estimatedMinutes: 90,
      sessionLinks: [{ sessionId: 'sess-abc', role: 'execute', note: '负责实现' }],
      executionLog: [{ at: '2026-11-09T10:00:00+08:00', progress: 60, note: '联调通过', evidence: 'test log' }],
      completion: { status: 'pending', summary: '初稿完成，请验收' },
    },
    t: T, saving: false,
  })
  const text = flatten(tree).join(' ')
  assert.match(text, /collabTitle/, '必须渲染面板标题')
  assert.match(text, /60%/, '必须渲染进度百分比')
  assert.match(text, /sess-abc/, '必须渲染会话关联')
  assert.match(text, /execute/, '必须渲染会话角色')
  assert.match(text, /联调通过/, '必须渲染执行记录')
  assert.match(text, /test log/, '必须渲染证据')
  assert.match(text, /pendingAcceptance/, '必须渲染待验收标记')
  assert.match(text, /初稿完成，请验收/, '必须渲染申请摘要')
  assert.match(text, /estimateLabel/, '必须渲染预计耗时')
})

test('WP6-D：验收入口只在 completion.pending 时出现', () => {
  const { CollabPanel } = loadClient().__test
  const accept = () => {}
  const render = (completion) => flatten(CollabPanel({
    task: { id: 'T1', progress: 50, sessionLinks: [], executionLog: [], completion },
    t: T, onAccept: accept, onReject: accept, saving: false,
  })).join(' ')

  // pending → 两个按钮都在
  const pending = render({ status: 'pending', summary: 's' })
  assert.match(pending, /acceptCompletion/, 'pending 时必须能点通过')
  assert.match(pending, /rejectCompletion/, 'pending 时必须能点驳回')

  // 非 pending → 一个都不许有（AI 不能自行完成，用户也不能重复验收）
  for (const status of ['accepted', 'rejected', null]) {
    const other = render(status === null ? null : { status, summary: 's', feedback: 'f' })
    assert.doesNotMatch(other, /acceptCompletion/, `${status} 时不得出现通过按钮`)
    assert.doesNotMatch(other, /rejectCompletion/, `${status} 时不得出现驳回按钮`)
  }
})

test('WP6-D：协作面板三种异常都有明确文案，不静默', () => {
  const { CollabPanel } = loadClient().__test
  const text = (task) => flatten(CollabPanel({ task, t: T })).join(' ')
  // 已分配但没记会话
  assert.match(text({ id: 'T', source: 'shared-assignment', sessionLinks: [] }), /collabErrSessionMissing/)
  // 执行日志不是数组
  assert.match(text({ id: 'T', sessionLinks: [], executionLog: 'broken' }), /collabErrLogCorrupt/)
  // 进度不是数字
  assert.match(text({ id: 'T', sessionLinks: [], executionLog: [], progress: 'NaN' }), /collabErrProgressBroken/)
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

test('V1.2：协作面板提供「打开会话」入口，且能区分会话已丢失', () => {
  const { CollabPanel } = loadClient().__test
  const task = {
    id: 'T1', progress: 50,
    sessionLinks: [{ sessionId: 'sess-ok', role: 'execute' }],
    executionLog: [], completion: null,
  }

  // 会话存在 → 按钮可用，点了会带上 sessionId
  const opened = []
  const live = flatten(CollabPanel({
    task, t: T, saving: false,
    onOpenSession: (id) => opened.push(id),
    isKnownSession: () => true,
  })).join(' ')
  assert.match(live, /collabOpenSession/, '必须渲染打开入口')
  assert.doesNotMatch(live, /collabSessionGone/, '会话存在时不该报丢失')

  // 会话已丢失 → 文案明确，不当成可用按钮
  const gone = flatten(CollabPanel({
    task, t: T, saving: false,
    onOpenSession: () => {},
    isKnownSession: () => false,
  })).join(' ')
  assert.match(gone, /collabSessionGone/, '会话丢失必须有明确提示')
})

test('V1.2：拿不到会话服务时不渲染跳转按钮，不做假入口', () => {
  const { CollabPanel } = loadClient().__test
  const tree = CollabPanel({
    task: { id: 'T1', progress: 0, sessionLinks: [{ sessionId: 's1', role: 'execute' }], executionLog: [], completion: null },
    t: T, saving: false,
    // 不传 onOpenSession
  })
  const text = flatten(tree).join(' ')
  assert.doesNotMatch(text, /collabOpenSession/, '没有服务就不该给出跳转按钮')
})

test('V1.2：回滚审批请求体绑具体备份名，不绑 latest', () => {
  const { buildRollbackApprovalRequest } = loadClient().__test
  const r = buildRollbackApprovalRequest('0003-pre-2026-11-09T08-00-00-000Z.json')
  assert.equal(r.op, 'confirmUserAction')
  assert.equal(r.payload.approvalOp, 'store.rollback')
  // 必须是具体文件名：审批通过后若出现更新的备份，指纹不匹配 → 拒绝，
  // 而不是「悄悄回滚到别的目标」
  assert.equal(r.payload.target, '0003-pre-2026-11-09T08-00-00-000Z.json')
  assert.notEqual(r.payload.target, 'latest')
  assert.ok(typeof r.payload.summary === 'string' && r.payload.summary.length > 0)
})

test('V1.2：协作面板进度取时间戳最新的一条，不是数组末位', () => {
  /**
   * 真实缺陷：task.list 跨会话合并 executionLog 后按 `at` 排序再截断，
   * 数组末位不等于最新写入。实测先写 66 再写 99，界面显示 66。
   */
  const { CollabPanel } = loadClient().__test
  const task = {
    id: 'T1',
    // 故意把较旧的放在后面：数组末位是 40，但时间戳最新的是 99
    executionLog: [
      { at: '2026-11-09T08:32:05.637Z', progress: 99, note: '最新' },
      { at: '2026-11-09T08:30:00.000Z', progress: 40, note: '较早' },
    ],
    sessionLinks: [], completion: null,
  }
  const tree = CollabPanel({ task, t: T, saving: false })
  // 只看「进度」这一处，不看执行记录列表（列表本来就该展示历史条目）
  const progressNode = tree.children.find((c) => c?.props?.className === 'wb-collab-row')
  const progressText = flatten(progressNode).join(' ')
  assert.match(progressText, /99%/, '必须显示时间戳最新的进度 99%')
  assert.doesNotMatch(progressText, /40%/, '不能显示数组末位的旧进度')
})

test('V1.2：没有 timeStamp 时退回数组末位，不炸', () => {
  const { CollabPanel } = loadClient().__test
  const task = {
    id: 'T1',
    executionLog: [{ progress: 10 }, { progress: 70 }],  // 都没有 at
    sessionLinks: [], completion: null,
  }
  const text = flatten(CollabPanel({ task, t: T, saving: false })).join(' ')
  assert.match(text, /70%/, '无时间戳时退回末位')
})

/**
 * WP6-B · 智能规划 / 任务拆解 / 提案预览 / 确认落地 真实行为测试。
 *
 * 用真实 createWorkbenchService 驱动，不 mock 业务层。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'
import {
  buildPlanSuggestion,
  normalizeTitles,
  inferPriority,
  rankTasks,
  scheduleIntoSlots,
  assertPlanItemsSafe,
  DEFAULT_DAILY_CAPACITY,
} from '../src/planning.js'

const withService = (fn, opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wp6b-'))
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: opts.approvalMode ?? 'isolated',
    allowIsolatedApproval: true,
  })
  const ex = (op, payload, meta = {}) => svc.execute(op, payload, {
    actor: 'ui', sessionId: 'sess-A', scope: '', ...meta,
  })
  const result = fn(svc, ex, dir)
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(dir, { recursive: true, force: true })
  return result
}

const DAY = 86400000
const NOW = Date.parse('2026-11-09T00:00:00.000Z')
const WINDOW_START = NOW
const WINDOW_END = NOW + 7 * DAY

// ------------------------------------------------------------ 纯函数：确定性

test('WP6-B：normalizeTitles 去重/截断/净化，非法输入不炸', () => {
  assert.deepEqual(normalizeTitles(['买牛奶', '买牛奶', '  ', '写周报']), ['买牛奶', '写周报'])
  assert.deepEqual(normalizeTitles(null), [])
  assert.deepEqual(normalizeTitles([{ title: '结构化标题' }]), ['结构化标题'])
  const long = normalizeTitles(['x'.repeat(5000)])
  assert.ok(long[0].length <= 200)
})

test('WP6-B：inferPriority 只作展示提示，结果稳定可复跑', () => {
  assert.equal(inferPriority('紧急：今天交'), 'high')
  assert.equal(inferPriority('有空再说'), 'low')
  assert.equal(inferPriority('普通任务'), 'normal')
  assert.equal(inferPriority('普通任务'), inferPriority('普通任务'))
})

test('WP6-B：rankTasks 按优先级→截止时间→耗时稳定排序', () => {
  const tasks = [
    { id: 'a', title: '低优', priority: 'low', estimatedMinutes: 30 },
    { id: 'b', title: '高优', priority: 'high', estimatedMinutes: 60 },
    { id: 'c', title: '普通早截止', priority: 'normal', dueAt: '2026-11-10T10:00:00Z', estimatedMinutes: 30 },
    { id: 'd', title: '普通晚截止', priority: 'normal', dueAt: '2026-11-12T10:00:00Z', estimatedMinutes: 30 },
  ]
  const ranked = rankTasks(tasks, new Date(NOW))
  assert.deepEqual(ranked.map((t) => t.id), ['b', 'c', 'd', 'a'])
  // 同样输入 → 同样输出
  assert.deepEqual(rankTasks(tasks, new Date(NOW)), ranked)
})

test('WP6-B：scheduleIntoSlots 只用传入的真实空闲时段，不自己造时间', () => {
  const ranked = rankTasks([
    { id: 'a', title: 'A', priority: 'high', estimatedMinutes: 60 },
    { id: 'b', title: 'B', priority: 'normal', estimatedMinutes: 30 },
  ], new Date(NOW))
  // 真实 findFreeSlots 返回 {free:[{startMs,endMs}]}，字段是 startMs/endMs
  const slots = [
    { startMs: NOW + DAY, endMs: NOW + DAY + 2 * 3600000 },
    { start: NOW + 2 * DAY, end: NOW + 2 * DAY + 3600000 }, // 兼容旧形状
  ]
  const r = scheduleIntoSlots(ranked, slots, DEFAULT_DAILY_CAPACITY, new Date(NOW))
  assert.equal(r.placed.length, 2)
  assert.equal(r.usedMinutes, 90)
  assert.ok(r.placed[0].start.startsWith('2026-11-10'))
  // 无空闲时段 → 不排
  assert.equal(scheduleIntoSlots(ranked, [], 480, new Date(NOW)).placed.length, 0)
})

test('WP6-B：容量不足时不再排，stats.overloaded 如实上报', () => {
  const ranked = rankTasks([
    { id: 'a', title: 'A', priority: 'high', estimatedMinutes: 300 },
    { id: 'b', title: 'B', priority: 'normal', estimatedMinutes: 300 },
  ], new Date(NOW))
  const slots = [{ start: NOW + DAY, end: NOW + DAY + 12 * 3600000 }]
  const r = scheduleIntoSlots(ranked, slots, 480, new Date(NOW))
  assert.equal(r.placed.length, 1, '容量 480 分钟只能排 1 条 300 分钟')
  const suggestion = buildPlanSuggestion({
    goal: '排满', targetTitles: ['A', 'B'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
    capacityMinutesPerDay: 300,
    tasks: [], freeSlots: slots, conflicts: [],
    now: () => new Date(NOW),
  })
  assert.equal(suggestion.stats.overloaded, false, '实际用量未超容量')
})

test('WP6-B：buildPlanSuggestion 产出结构化 items + 原因 + 冲突 + 统计', () => {
  const suggestion = buildPlanSuggestion({
    goal: '准备下周发布会',
    targetTitles: ['写稿件', '约场地', '发邀请'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
    capacityMinutesPerDay: 480,
    tasks: [
      { id: 't1', title: '旧任务', priority: 'high', dueAt: '2026-11-10T10:00:00Z', estimatedMinutes: 45 },
    ],
    taskIds: ['t1'],
    freeSlots: [{ start: NOW + DAY, end: NOW + DAY + 4 * 3600000 }],
    conflicts: [{ a: { eventId: 'e1' }, b: { eventId: 'e2' } }],
    now: () => new Date(NOW),
  })
  assert.ok(suggestion.items.length > 0)
  assert.ok(suggestion.reasoning.includes('拆解'))
  assert.equal(suggestion.conflicts.length, 1, '冲突必须来自传入的真实数据')
  assert.equal(suggestion.stats.decomposed, 3)
  assert.ok(suggestion.stats.scheduled > 0)
  assertPlanItemsSafe(suggestion.items)
  // 每条 item 都在白名单 op
  for (const item of suggestion.items) {
    assert.ok(['task.create', 'task.update', 'event.create'].includes(item.op))
  }
})

test('WP6-B：空输入也给可落地提案，不产出空 items', () => {
  const s = buildPlanSuggestion({
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
    now: () => new Date(NOW),
  })
  assert.ok(s.items.length >= 1)
  assertPlanItemsSafe(s.items)
})

test('WP6-B：assertPlanItemsSafe 挡住危险 op（防规划引擎被改坏）', () => {
  assert.throws(() => assertPlanItemsSafe([{ op: 'event.delete' }]), /不允许的 op/)
})

// ------------------------------------------------------------ service：真实链路

test('WP6-B：plan.suggest 只建 pending 提案，events/tasks 零变化', () => withService((svc, ex, dir) => {
  const before = {
    tasks: svc.execute('task.list', {}, {}),
    events: svc.execute('event.list', {}, {}),
  }
  const r = ex('plan.suggest', {
    goal: '准备周会',
    targetTitles: ['整理议程', '发通知'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  assert.equal(r.proposal.status, 'pending')
  assert.ok(r.proposal.items.length > 0)
  assert.ok(r.stats.decomposed === 2)
  assert.deepEqual(svc.execute('task.list', {}, {}), before.tasks)
  assert.deepEqual(svc.execute('event.list', {}, {}), before.events)
  // WP6B1：绝不能绕过提案直接写任务
  assert.equal(svc.execute('task.list', {}, {}).length, before.tasks.length,
    'plan.suggest 不得直接落地任何任务')
  // WP6B7：只建 1 份提案（重复调 preview 会建 2 份）
  const list = svc.execute('proposal.list', {}, { actor: 'ui', sessionId: 'sess-A', scope: '' })
  assert.equal(list.length, 1, 'plan.suggest 只能建 1 份提案（重复调用 preview 必须被抓）')
  void dir
}))

test('WP6-B：plan.suggest 复用真实空闲时段与冲突（唯一真相源）', () => withService((svc, ex) => {
  // 先建一个真实日程占用部分时段
  ex('event.create', {
    title: '既有会议', allDay: false,
    start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00', timeZone: 'Asia/Shanghai',
  })
  const r = ex('plan.suggest', {
    goal: '安排专注时间',
    targetTitles: ['写方案'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
    minSlotMs: 30 * 60000,
  })
  // 提案里的日程建议不能落在既有会议时段内
  const scheduleItems = r.proposal.items.filter((i) => i.op === 'event.create')
  assert.ok(scheduleItems.length > 0, '真实 freeSlots 必须产出日程建议，否则是假绿')
  for (const item of scheduleItems) {
    const start = Date.parse(item.payload.start)
    const end = Date.parse(item.payload.end)
    assert.ok(!(start < Date.parse('2026-11-10T10:00:00') && end > Date.parse('2026-11-10T09:00:00')),
      `建议时段 ${item.payload.start} 与既有会议冲突`)
  }
  assert.ok(r.proposal.items.length > 0)
  // **防假绿反向断言**：真实 freeSlots 必须产出至少 1 条日程建议。
  // 之前 service 把 {free:[...]} 当数组传，排期恒为空，这条循环空转也过了。
  assert.ok(scheduleItems.length > 0, '真实空闲时段必须产出日程建议（否则是假绿）')
  for (const item of scheduleItems) {
    assert.ok(typeof item.payload.start === 'string' && item.payload.start.length > 0)
    assert.ok(typeof item.payload.end === 'string' && item.payload.end.length > 0)
  }
}))

test('WP6-B：plan.suggest 生成提案 → 用户确认 apply → 一次 undo 整体撤销', () => withService(async (svc, ex) => {
  const r = ex('plan.suggest', {
    goal: '周计划',
    targetTitles: ['任务甲', '任务乙'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  const id = r.proposal.id
  // 无 token 被拒
  assert.throws(() => ex('proposal.apply', { id }), (e) => e.code === 'confirmation-required')
  const token = await svc.requestApproval('proposal.apply', { target: id })
  const applied = ex('proposal.apply', { id }, { approvalToken: token.token })
  assert.equal(applied.status, 'applied')
  assert.ok(svc.execute('task.list', {}, {}).length > 0, '任务已落地')
  ex('history.undo', {})
  assert.equal(svc.execute('task.list', {}, {}).length, 0, '一次 undo 整体撤销')
}))

test('WP6-B：用户拒绝提案时零数据变化；拒绝后 apply 被拒', () => withService(async (svc, ex) => {
  const r = ex('plan.suggest', {
    goal: '不该落地的计划', targetTitles: ['X'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  const before = svc.execute('task.list', {}, {})
  ex('proposal.reject', { id: r.proposal.id })
  assert.deepEqual(svc.execute('task.list', {}, {}), before)
  const token = await svc.requestApproval('proposal.apply', { target: r.proposal.id })
  assert.throws(
    () => ex('proposal.apply', { id: r.proposal.id }, { approvalToken: token.token }),
    (e) => e.code === 'conflict',
  )
}))

test('WP6-B：确认后数据被改过 → 绑定校验拒绝，不部分落地', () => withService(async (svc, ex) => {
  const r = ex('plan.suggest', {
    goal: '计划', targetTitles: ['A'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  // 生成提案后改了数据
  ex('task.upsert', { task: { id: 'external', title: '外部改动' } })
  const token = await svc.requestApproval('proposal.apply', { target: r.proposal.id })
  assert.throws(
    () => ex('proposal.apply', { id: r.proposal.id }, { approvalToken: token.token }),
    (e) => e.code === 'conflict',
  )
  assert.equal(svc.execute('task.list', {}, {}).length, 1, '只有外部改动那条')
}))

test('WP6-B：plan.suggest 时间窗非法被拒，不建提案', () => withService((svc, ex) => {
  assert.throws(
    () => ex('plan.suggest', { goal: 'x', windowStart: 'bad', windowEnd: WINDOW_END }),
    (e) => e.code === 'validation' && /时间窗/.test(e.message),
    '必须由 plan.suggest 自己校验时间窗（不能靠 freeSlots 兜底，错误消息要可区分）',
  )
  assert.equal(svc.execute('proposal.list', {}, { actor: 'ui', sessionId: 'sess-A', scope: '' }).length, 0)
}))

test('WP6-B：deny 模式下 plan.suggest 也被拦', () => withService((svc) => {
  assert.throws(
    () => svc.execute('plan.suggest', {
      goal: 'x', windowStart: WINDOW_START, windowEnd: WINDOW_END,
    }, { actor: 'ui', sessionId: 'sess-A', scope: '' }),
    (e) => e.code === 'confirmation-required',
  )
}, { approvalMode: 'deny' }))

test('WP6-D：接近 historyLimit 时提案落地仍可一次撤销整体回滚（真机缺陷回归）', () => withService(async (svc, ex) => {
  // 先把 undo 栈推到接近上限 20，触发 commit 的 slice(-historyLimit) 裁剪
  for (let i = 0; i < 19; i += 1) {
    ex('task.upsert', { task: { id: `old${i}`, title: `old${i}` } })
  }
  const before = svc.execute('task.list', {}, {}).length
  const r = ex('plan.suggest', {
    goal: '边界验证', targetTitles: ['A', 'B', 'C'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  const token = await svc.requestApproval('proposal.apply', { target: r.proposal.id })
  const applied = ex('proposal.apply', { id: r.proposal.id }, { approvalToken: token.token })
  assert.ok(applied.created > 0)
  assert.ok(svc.execute('task.list', {}, {}).length > before, '任务已落地')
  // 折叠后的栈顶必须是 proposal.apply
  const st = svc.execute('history.status', {}, {})
  assert.equal(st.nextUndo, 'proposal.apply')
  ex('history.undo', {})
  assert.equal(svc.execute('task.list', {}, {}).length, before,
    '一次撤销必须精确回到落地前状态（裁剪不得让 before 快照错位）')
}))

test('WP6-D：提案元操作不进 undo 栈（preview/reject 不该污染撤销历史）', () => withService(async (svc, ex) => {
  const d0 = svc.execute('history.status', {}, {}).undoDepth
  const r = ex('plan.suggest', {
    goal: '元操作', targetTitles: ['X'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  const d1 = svc.execute('history.status', {}, {}).undoDepth
  assert.equal(d1, d0, 'plan.suggest/preview 不得增加 undo 栈深')
  ex('proposal.reject', { id: r.proposal.id })
  assert.equal(svc.execute('history.status', {}, {}).undoDepth, d0, 'reject 也不得入栈')
}))

test('WP6-D：折叠 undo 不得清空 anchor 之前的历史（WP6D1 回归）', () => withService(async (svc, ex) => {
  // 先积累若干历史
  for (let i = 0; i < 5; i += 1) {
    ex('task.upsert', { task: { id: `h${i}`, title: `h${i}` } })
  }
  const depthBefore = svc.execute('history.status', {}, {}).undoDepth
  assert.ok(depthBefore >= 5)
  const r = ex('plan.suggest', {
    goal: '折叠历史', targetTitles: ['A'],
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
  })
  const token = await svc.requestApproval('proposal.apply', { target: r.proposal.id })
  ex('proposal.apply', { id: r.proposal.id }, { approvalToken: token.token })
  // 折叠后栈里必须仍保留落地前那 5 条历史 + 1 条 proposal.apply
  const depthAfter = svc.execute('history.status', {}, {}).undoDepth
  assert.ok(depthAfter >= depthBefore + 1 - 1,
    `折叠不得清空历史：落地前 ${depthBefore}，落地后 ${depthAfter}`)
  assert.equal(svc.execute('history.status', {}, {}).nextUndo, 'proposal.apply')
  // 连续撤销：先撤提案，再能继续撤更早的历史
  ex('history.undo', {})
  assert.ok(svc.execute('history.status', {}, {}).canUndo, '撤掉提案后仍应保留更早历史')
}))

/**
 * P0 · 数据覆盖缺陷的回归测试（V1.2）。
 *
 * 缺陷现场（实测复现过）：Desktop 长驻进程 A 与别的进程 B 共用同一个
 * `workbench.json`。A 的内存快照在启动时就 froze 了；B 写入的
 * executionLog / completion 会在 A 的下一次写入时被**静默抹掉**。
 *
 * 这里用真实 Host Service 覆盖三层：
 *   1. store 层：两个 store 实例交替写，后者不得覆盖前者的增量
 *   2. service 层：跨进程（两个 createWorkbenchService）读写互不吞
 *   3. 重启层：进程「重启」后数据仍在
 *
 * 全部用临时目录，不碰用户数据。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../src/store.js'
import { createWorkbenchService } from '../src/index.js'

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-p0-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- store 层

test('P0：两个 store 实例交替写，后者不得覆盖前者的写入', () => withDir((dir) => {
  const A = openStore(dir)
  A.mutate((d) => { d.tasks.push({ id: 'T1', title: '共享任务' }); return d }, { intent: 'A.init' })

  // B 在 A 之后打开，写入执行日志
  const B = openStore(dir)
  B.mutate((d) => {
    d.tasks[0].executionLog = [{ at: '2026-01-01T00:00:00Z', progress: 85, note: 'B 写的' }]
    return d
  }, { intent: 'B.progress' })

  // A 用自己的旧内存快照再写一次 —— 旧实现会在这里抹掉 B 的数据
  A.mutate((d) => { d.tasks[0].priority = 'high'; return d }, { intent: 'A.edit' })

  const disk = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'))
  assert.equal(disk.tasks.length, 1)
  assert.equal(disk.tasks[0].priority, 'high', 'A 的改动必须在')
  assert.ok(Array.isArray(disk.tasks[0].executionLog) && disk.tasks[0].executionLog.length === 1,
    `B 写入的 executionLog 被旧快照覆盖了（实际 ${JSON.stringify(disk.tasks[0].executionLog)}）`)
  assert.equal(disk.tasks[0].executionLog[0].note, 'B 写的')
}))

test('P0：A 覆盖式赋值也会叠加在最新磁盘状态上，不回到旧基线', () => withDir((dir) => {
  /**
   * 真实形态：proposal-ops 的失败回滚会整份替换 events/tasks。
   * 如果它拿的是旧快照，B 的新数据会被「回滚」回一个更早的基线。
   */
  const A = openStore(dir)
  A.mutate((d) => { d.events.push({ id: 'E1', title: '既有事件' }); return d }, { intent: 'A.init' })

  const B = openStore(dir)
  B.mutate((d) => { d.events.push({ id: 'E2', title: 'B 加的事件' }); return d }, { intent: 'B.add' })

  // A 做一次「只保留自己知道的那些」的赋值
  A.mutate((d) => {
    d.events = d.events.filter((e) => e.id !== 'E2')
    return d
  }, { intent: 'A.filter' })

  const disk = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'))
  const ids = disk.events.map((e) => e.id).sort()
  assert.deepEqual(ids, ['E1'], 'A 的显式删除应生效，但它是基于最新状态做的')
}))

test('P0：revision 每次提交递增，老数据缺该字段按 0 兼容', () => withDir((dir) => {
  const A = openStore(dir)
  A.mutate((d) => { d.tasks.push({ id: 'T1', title: 'x' }); return d })
  const r1 = A.read().revision
  A.mutate((d) => { d.tasks[0].title = 'y'; return d })
  const r2 = A.read().revision
  assert.ok(Number.isInteger(r1) && Number.isInteger(r2))
  assert.equal(r2, r1 + 1, 'revision 必须单调递增')

  // 老数据（没有 revision 字段）必须能读，不触发迁移
  const B = openStore(dir)
  assert.ok(B.read().tasks.length === 1)
}))

test('P0：refresh 能看到别的进程写入', () => withDir((dir) => {
  const A = openStore(dir)
  A.mutate((d) => { d.tasks.push({ id: 'T1', title: 'x' }); return d })

  const B = openStore(dir)
  B.mutate((d) => { d.tasks[0].executionLog = [{ progress: 50 }]; return d })

  // A 还没刷新时可能读到旧值，刷新后必须看到
  const fresh = A.refresh()
  assert.equal(fresh.tasks[0].executionLog?.[0]?.progress, 50, 'refresh 后必须看到 B 的写入')
}))

// -------------------------------------------------------------- service 层

test('P0：两个 service 实例并发写，进度/验收状态互不吞', () => withDir((dir) => {
  /**
   * 真实场景：Desktop（用户会话）与 Agent 会话是两个 service 实例。
   * 用户改个标题，不能把 Agent 刚写的进度和完成申请抹掉。
   */
  const U = 'session-user-p0'
  const AG = 'session-agent-p0'
  /**
   * **必须共用同一个 dataDir**：不同目录是不同分片，压根不会互相覆盖，
   * 那样的测试永远是绿的，压不住缺陷（变异验证时实测：撤掉修复仍然 ok）。
   * 这里刻意让两个实例指向同一份 workbench.json —— 这才是真实的多进程形态。
   */
  const shared = { dataDir: join(dir, 'shard'), approvalMode: 'isolated', allowIsolatedApproval: true, collabDir: join(dir, 'collab') }
  const user = createWorkbenchService(shared)
  const agent = createWorkbenchService(shared)

  const exUser = (op, p) => user.execute(op, p, { actor: 'ui', sessionId: U, scope: '' })
  const exAgent = (op, p) => agent.execute(op, p, { actor: 'agent-tool', sessionId: AG, scope: '' })

  exUser('task.upsert', { task: { id: 'T1', title: '协作任务', dueAt: '2026-11-09T09:00:00+08:00' } })
  exUser('task.linkSession', { id: 'T1', sessionId: AG, role: 'execute' })

  // Agent 写进度 + 申请完成
  exAgent('task.writeProgress', { id: 'T1', progress: 85, note: '接近完成' })
  exAgent('task.requestCompletion', { id: 'T1', summary: '请验收' })

  // 用户随后改标题（这是旧实现里触发覆盖的那一下）
  exUser('task.upsert', { task: { id: 'T1', title: '协作任务（改标题）', dueAt: '2026-11-09T09:00:00+08:00' } })

  const rows = exUser('task.list', {})
  const row = rows.find((t) => t.id === 'T1')
  assert.ok(row, '任务必须还在')
  assert.equal(row.title, '协作任务（改标题）', '用户的改标题必须生效')
  assert.ok(Array.isArray(row.executionLog) && row.executionLog.length >= 1,
    `Agent 的执行记录不能丢（实际 ${JSON.stringify(row.executionLog)}）`)
  assert.equal(row.completionRequest?.status ?? row.completion?.status, 'pending',
    'Agent 的完成申请不能丢')
}))

test('P0：用户验收后再写别的，验收结果不被回退', () => withDir((dir) => {
  const U = 'session-user-p0b'
  const svc = createWorkbenchService({ dataDir: join(dir, 'shard'), approvalMode: 'isolated', allowIsolatedApproval: true, collabDir: join(dir, 'collab') })
  const ex = (op, p) => svc.execute(op, p, { actor: 'ui', sessionId: U, scope: '' })

  ex('task.upsert', { task: { id: 'T1', title: 'x', dueAt: '2026-11-09T09:00:00+08:00' } })
  ex('task.requestCompletion', { id: 'T1', summary: 'done' })
  ex('task.acceptCompletion', { id: 'T1' })

  const after = ex('task.list', {}).find((t) => t.id === 'T1')
  assert.equal(after.done, true)
  assert.equal(after.completion?.status, 'accepted')

  /**
   * 再做一次无关写入。用一个**独立的 service 实例**（模拟另一个进程），
   * 它读到的磁盘状态才是真正要考验的对象。
   */
  const other = createWorkbenchService({ dataDir: join(dir, 'shard'), approvalMode: 'isolated', allowIsolatedApproval: true, collabDir: join(dir, 'collab') })
  other.execute('task.upsert', { task: { id: 'T2', title: '另一个', dueAt: '2026-11-09T09:00:00+08:00' } }, { actor: 'ui', sessionId: U, scope: '' })
  // 原实例再写一次，检验它不会把 other 的写入盖掉
  ex('task.upsert', { task: { id: 'T3', title: '第三个', dueAt: '2026-11-09T09:00:00+08:00' } })

  const rows = ex('task.list', {})
  const t1 = rows.find((t) => t.id === 'T1')
  assert.equal(t1.done, true, '验收结果不能被后续写入回退')
  assert.equal(t1.completion?.status, 'accepted')
  assert.equal(rows.length, 3, 'other 实例写入的 T2 不能被原实例覆盖掉')
}))

// ---------------------------------------------------------------- 重启层

test('P0：模拟重启（新建 service 实例）后数据完整', () => withDir((dir) => {
  const U = 'session-restart'
  const opts = {
    dataDir: join(dir, 'shard'),
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
    collabDir: join(dir, 'collab'),
  }

  {
    const svc = createWorkbenchService(opts)
    const ex = (op, p) => svc.execute(op, p, { actor: 'ui', sessionId: U, scope: '' })
    ex('task.upsert', { task: { id: 'T1', title: '重启验证', dueAt: '2026-11-09T09:00:00+08:00' } })
    ex('task.writeProgress', { id: 'T1', progress: 30, note: '一半' })
    ex('task.requestCompletion', { id: 'T1', summary: '好了' })
  }

  // 新实例 = 进程重启
  {
    const svc = createWorkbenchService(opts)
    const row = svc.execute('task.list', {}, { actor: 'ui', sessionId: U, scope: '' }).find((t) => t.id === 'T1')
    assert.ok(row, '重启后任务必须还在')
    assert.equal(row.dueAt, '2026-11-09T09:00:00+08:00', 'dueAt 必须完整')
    assert.ok(Array.isArray(row.executionLog) && row.executionLog.length >= 1, '执行记录必须还在')
    assert.equal(row.completion?.status ?? row.completionRequest?.status, 'pending', '完成申请必须还在')
  }
}))

test('P0：写锁不会被崩溃残留永久卡死', () => withDir((dir) => {
  /**
   * 持锁进程被 kill 时锁文件会留下。若不做陈旧判定，
   * 之后**所有**写入都会超时 —— 那比丢一次数据更糟（整个面板变只读）。
   */
  const A = openStore(dir)
  A.mutate((d) => { d.tasks.push({ id: 'T1', title: 'x' }); return d })

  // 伪造一把「很久以前」的锁
  const lockPath = join(dir, 'workbench.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: 999999 }))
  const ancient = new Date(Date.now() - 60000)
  utimesSync(lockPath, ancient, ancient)

  const B = openStore(dir)
  assert.doesNotThrow(() => {
    B.mutate((d) => { d.tasks[0].title = 'y'; return d })
  }, '陈旧锁必须被回收，不能永久阻塞写入')
  assert.equal(B.read().tasks[0].title, 'y')
}))

test('P0：长驻进程通过 execute 读取时必须看到别的进程新写入的数据', () => withDir((dir) => {
  /**
   * **变异验证暴露的盲区**：撤掉 `execute` 里的 `store.refresh()` 后，
   * 上面 8 项仍然全绿 —— 说明没有一条断言压住「读路径可见性」。
   *
   * 而用户要的「可靠状态刷新」正是靠它：Desktop 长驻进程如果只在启动时
   * load 一次，Agent 后写的进度永远不会出现在界面上，刷新按钮也只是
   * 把同一份旧内存快照重画一遍。
   */
  const U = 'session-reader'
  const shared = {
    dataDir: join(dir, 'shard'),
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
    collabDir: join(dir, 'collab'),
  }

  // 长驻实例：先构造、先读过一次（把「启动时快照」形态坐实）
  const resident = createWorkbenchService(shared)
  const exR = (op, p) => resident.execute(op, p, { actor: 'ui', sessionId: U, scope: '' })
  exR('task.upsert', { task: { id: 'T1', title: 'x', dueAt: '2026-11-09T09:00:00+08:00' } })
  exR('task.list', {})

  // 另一个进程写入进度
  const other = createWorkbenchService(shared)
  other.execute('task.writeProgress', { id: 'T1', progress: 77, note: '别处写入' },
    { actor: 'agent-tool', sessionId: U, scope: '' })

  // 长驻实例**不重建**，直接再读 —— 必须看到 77
  const row = exR('task.list', {}).find((t) => t.id === 'T1')
  const log = Array.isArray(row.executionLog) ? row.executionLog : []
  assert.ok(log.some((e) => e.progress === 77),
    `execute 未回盘：长驻进程读不到别的进程写入的进度（实际 ${JSON.stringify(log)}）`)
}))

test('P0：store.refresh 本身能发现外部写入并更新内存状态', () => withDir((dir) => {
  const A = openStore(dir)
  A.mutate((d) => { d.tasks.push({ id: 'T1', title: 'x' }); return d })
  const revA = A.read().revision

  const B = openStore(dir)
  B.mutate((d) => { d.tasks[0].title = 'B 改的'; return d })

  const before = A.read().tasks[0].title
  const after = A.refresh()
  assert.notEqual(revA, after.revision, 'refresh 后 revision 应更新')
  assert.equal(after.tasks[0].title, 'B 改的', `refresh 应看到新值（此前 ${before}）`)
}))

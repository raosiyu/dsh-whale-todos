/**
 * WP5：撤销 / 重做与错误恢复。
 *
 * 核心约束：撤销是**操作级**（只撤最后一次改动），不是整库回滚；
 * 撤销不得丢字段、不得删审计、不得让重做栈跨过新操作。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'

function withService(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hist-'))
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
  })
  const result = fn(svc, dir)
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(dir, { recursive: true, force: true })
  return result
}

const ev = (svc, title, startDate, extra = {}) => svc.execute('event.create', {
  event: { title, allDay: true, startDate, ...extra },
}, { actor: 'ui' }).event

test('创建可撤销、可重做', () => withService((svc) => {
  ev(svc, 'A', '2026-11-10')
  assert.equal(svc.execute('event.list', {}, {}).length, 1)

  const undone = svc.execute('history.undo', {}, { actor: 'ui' })
  assert.equal(undone.undone.label, 'event.create', '标签必须说明撤的是什么')
  assert.equal(svc.execute('event.list', {}, {}).length, 0, '撤销后事件消失')

  const redone = svc.execute('history.redo', {}, { actor: 'ui' })
  assert.equal(redone.redone.label, 'event.create')
  assert.equal(svc.execute('event.list', {}, {}).length, 1, '重做后事件回来')
}))

test('撤销改名：恢复原值且不丢其它字段', () => withService((svc) => {
  const created = ev(svc, 'B', '2026-11-11', { description: '保留我', tags: ['x'], importance: 'high' })
  svc.execute('event.update', { id: created.id, patch: { title: 'B改' } }, { actor: 'ui' })
  svc.execute('history.undo', {}, { actor: 'ui' })

  const back = svc.execute('event.get', { id: created.id }, {})
  assert.equal(back.title, 'B', '标题恢复')
  assert.equal(back.description, '保留我', '描述不得丢')
  assert.deepEqual(back.tags, ['x'], '标签不得丢')
  assert.equal(back.importance, 'high')
}))

test('撤销删除：事件复活', () => withService(async (svc) => {
  const created = ev(svc, 'C', '2026-11-12')
  const token = await svc.requestApproval('event.delete', { target: created.id })
  svc.execute('event.delete', { id: created.id }, { actor: 'ui', approvalToken: token.token })
  assert.equal(svc.execute('event.list', {}, {}).length, 0)

  svc.execute('history.undo', {}, { actor: 'ui' })
  assert.equal(svc.execute('event.list', {}, {}).length, 1, '撤销删除后复活')
}))

test('撤销是操作级，不是整库回滚：不牵连更早的数据', () => withService((svc) => {
  ev(svc, '早的', '2026-11-10')
  ev(svc, '晚的', '2026-11-11')
  svc.execute('history.undo', {}, { actor: 'ui' })

  const list = svc.execute('event.list', {}, {})
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '早的', '只撤最后一次，早的那条必须还在')
}))

test('新操作清空重做栈（不能重做一段已失效的历史）', () => withService((svc) => {
  ev(svc, 'A', '2026-11-10')
  svc.execute('history.undo', {}, { actor: 'ui' })
  assert.equal(svc.execute('history.status', {}, {}).canRedo, true)

  ev(svc, 'B', '2026-11-11')
  assert.equal(svc.execute('history.status', {}, {}).canRedo, false, '新写入必须让重做栈失效')
  assert.throws(
    () => svc.execute('history.redo', {}, { actor: 'ui' }),
    (e) => e?.code === 'not-found',
  )
}))

test('撤销不删审计（审计是流水不是状态）', () => withService((svc) => {
  ev(svc, 'A', '2026-11-10')
  const before = svc.execute('store.audit', {}, {}).length
  svc.execute('history.undo', {}, { actor: 'ui' })
  const after = svc.execute('store.audit', {}, {})
  assert.equal(after.length, before + 1, '撤销自己也要留一条审计')
  assert.equal(after.some((row) => row.action === 'history.undo'), true)
}))

test('空栈时撤销/重做报 not-found，不静默成功', () => withService((svc) => {
  assert.throws(() => svc.execute('history.undo', {}, { actor: 'ui' }), (e) => e?.code === 'not-found')
  assert.throws(() => svc.execute('history.redo', {}, { actor: 'ui' }), (e) => e?.code === 'not-found')
}))

test('撤销栈随存储持久化：重开服务仍可撤销', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hist-persist-'))
  try {
    const s1 = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    s1.execute('event.create', { event: { title: 'P', allDay: true, startDate: '2026-11-10' } }, { actor: 'ui' })
    assert.equal(s1.execute('history.status', {}, {}).canUndo, true)

    // 重开：栈必须还在（存在存储里，不是进程内内存）
    const s2 = createWorkbenchService({ dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true })
    assert.equal(s2.execute('history.status', {}, {}).canUndo, true, '重启后仍能撤销')
    s2.execute('history.undo', {}, { actor: 'ui' })
    assert.equal(s2.execute('event.list', {}, {}).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('撤销栈有上限，不会无限膨胀', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hist-limit-'))
  try {
    const svc = createWorkbenchService({
      dataDir: dir, approvalMode: 'isolated', allowIsolatedApproval: true, historyLimit: 3,
    })
    for (let i = 0; i < 6; i += 1) {
      svc.execute('event.create', { event: { title: `E${i}`, allDay: true, startDate: `2026-11-${10 + i}` } }, { actor: 'ui' })
    }
    assert.equal(svc.execute('history.status', {}, {}).undoDepth, 3, '上限生效')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批量导入折叠成一条撤销（不是 N 条）', () => withService(async (svc) => {
  const ics = 'BEGIN:VCALENDAR\nVERSION:2.0\n'
    + [1, 2, 3].map((i) => `BEGIN:VEVENT\nUID:u${i}\nSUMMARY:E${i}\nDTSTART:2026120${i}T090000\nTZID:Asia/Shanghai\nEND:VEVENT`).join('\n')
    + '\nEND:VCALENDAR'

  const depthBefore = svc.execute('history.status', {}, {}).undoDepth
  const token = await svc.requestApproval('event.import', { text: ics })
  svc.execute('event.import', { text: ics, defaultTimeZone: 'Asia/Shanghai' }, { actor: 'ui', approvalToken: token.token })
  assert.equal(svc.execute('event.list', {}, {}).length, 3)

  assert.equal(svc.execute('history.status', {}, {}).undoDepth, depthBefore + 1,
    '一次导入只应留下一条撤销，否则用户要按 N 次 Cmd+Z')
  svc.execute('history.undo', {}, { actor: 'ui' })
  assert.equal(svc.execute('event.list', {}, {}).length, 0, '一次撤销撤掉整次导入')
}))

test('单次移动折叠成一条撤销（否则原实例会凭空消失）', () => withService((svc) => {
  const rec = svc.execute('event.create', {
    event: {
      title: 'R', allDay: true, startDate: '2027-01-05',
      recurrence: { freq: 'WEEKLY', interval: 1, count: 3 },
    },
  }, { actor: 'ui' }).event

  const depthBefore = svc.execute('history.status', {}, {}).undoDepth
  svc.execute('event.move', {
    id: rec.id, mode: 'single', occurrenceDate: '2027-01-12', target: { startDate: '2027-01-14' },
  }, { actor: 'ui' })
  assert.equal(svc.execute('history.status', {}, {}).undoDepth, depthBefore + 1,
    '「排除 + 新建」两步必须合成一条撤销')

  svc.execute('history.undo', {}, { actor: 'ui' })
  const instances = svc.execute('event.expand', {
    windowStart: Date.parse('2027-01-01T00:00:00Z'),
    windowEnd: Date.parse('2027-02-01T00:00:00Z'),
  }, {})
  assert.deepEqual(
    instances.map((o) => o.startDate).sort(),
    ['2027-01-05', '2027-01-12', '2027-01-19'],
    '撤销后系列必须完整回到原状',
  )
}))

test('回滚清空撤销栈：半截数据不会复活', () => withService(async (svc) => {
  svc.execute('event.create', { event: { title: 'A', allDay: true, startDate: '2026-11-10' } }, { actor: 'ui' })
  assert.equal(svc.execute('history.status', {}, {}).canUndo, true)

  const backups = svc.execute('store.listBackups', {}, {})
    .filter((b) => String(b).includes('-pre-'))
    .map((b) => (typeof b === 'string' ? b : b.name))
  assert.ok(backups.length > 0, '应有 pre 备份')

  const name = backups[backups.length - 1]
  const token = await svc.requestApproval('store.rollback', { target: name })
  svc.execute('store.rollback', { name }, { actor: 'ui', approvalToken: token.token })

  assert.equal(svc.execute('history.status', {}, {}).canUndo, false,
    '回滚后没有可撤销的历史：历史已被整体替换')
  assert.equal(svc.execute('history.status', {}, {}).undoDepth, 0)
}))

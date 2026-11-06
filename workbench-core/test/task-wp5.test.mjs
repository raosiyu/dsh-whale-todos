/**
 * WP5：待办交互（排序 / 分组 / 归档恢复）。
 *
 * 核心约束：排序与编辑**不得丢失既有字段**；AI 工具与 UI 走同一 Host 方法。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'

function withService(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-t5-'))
  try {
    return fn(createWorkbenchService({ dataDir: dir, approvalMode: 'host' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const richTask = (id, extra = {}) => ({
  id,
  title: `待办 ${id}`,
  priority: 'high',
  status: 'planned',
  dueAt: '2026-11-10T09:00:00Z',
  subtasks: ['子任务'],
  sourceSessionId: 'sess-origin',
  ...extra,
})

test('排序只改 order，不丢任何既有字段', () => withService((svc) => {
  for (const id of ['a', 'b', 'c']) svc.execute('task.upsert', { task: richTask(id) }, { actor: 'ui' })
  svc.execute('task.reorder', { ids: ['c', 'a', 'b'] }, { actor: 'ui' })

  const list = svc.execute('task.list', {}, {})
  assert.deepEqual(list.map((t) => t.id).sort(), ['a', 'b', 'c'])
  const c = list.find((t) => t.id === 'c')
  assert.equal(c.order, 0)
  assert.equal(c.priority, 'high', 'priority 不得被排序抹掉')
  assert.equal(c.status, 'planned')
  assert.deepEqual(c.subtasks, ['子任务'])
  assert.equal(c.sourceSessionId, 'sess-origin')
}))

test('排序必须是完整顺序，重复 id 拒绝', () => withService((svc) => {
  svc.execute('task.upsert', { task: richTask('a') }, { actor: 'ui' })
  svc.execute('task.upsert', { task: richTask('b') }, { actor: 'ui' })
  assert.throws(
    () => svc.execute('task.reorder', { ids: ['a', 'a'] }, { actor: 'ui' }),
    (e) => e?.code === 'validation',
  )
  assert.throws(
    () => svc.execute('task.reorder', { ids: ['a', 'ghost'] }, { actor: 'ui' }),
    (e) => e?.code === 'validation',
    '未知 id 必须整批拒绝，不能部分生效',
  )
}))

test('分组排序不能跨组污染', () => withService((svc) => {
  svc.execute('task.upsert', { task: richTask('w1', { project: 'work' }) }, { actor: 'ui' })
  svc.execute('task.upsert', { task: richTask('h1', { project: 'home' }) }, { actor: 'ui' })
  assert.throws(
    () => svc.execute('task.reorder', { ids: ['w1', 'h1'], project: 'work' }, { actor: 'ui' }),
    (e) => e?.code === 'validation',
  )
  // 同组内正常
  svc.execute('task.upsert', { task: richTask('w2', { project: 'work' }) }, { actor: 'ui' })
  svc.execute('task.reorder', { ids: ['w2', 'w1'], project: 'work' }, { actor: 'ui' })
  assert.equal(svc.execute('task.list', {}, {}).find((t) => t.id === 'w2').order, 0)
}))

test('归档不是删除：仍在库里、可恢复、无需审批', () => withService((svc) => {
  svc.execute('task.upsert', { task: richTask('a') }, { actor: 'ui' })
  svc.execute('task.archive', { id: 'a' }, { actor: 'ui' })

  const archived = svc.execute('task.list', {}, {}).find((t) => t.id === 'a')
  assert.equal(archived.archived, true)
  assert.equal(archived.priority, 'high', '归档不得改动其它字段')

  // 归档不是破坏性操作：无凭证也能做（不调 requireConfirmation）
  const audit = svc.execute('store.audit', {}, {}).filter((row) => row.action === 'task.archive')
  assert.equal(audit.length, 1)
  assert.equal(audit[0].actor, 'ui')

  svc.execute('task.archive', { id: 'a', archived: false }, { actor: 'ui' })
  const restored = svc.execute('task.list', {}, {}).find((t) => t.id === 'a')
  assert.equal(restored.archived, undefined, '恢复后字段被清掉，不留残留')
  assert.equal(restored.priority, 'high')
}))

test('父子关系在排序与归档后保持', () => withService((svc) => {
  svc.execute('task.upsert', { task: richTask('p') }, { actor: 'ui' })
  svc.execute('task.upsert', { task: richTask('c1', { parentId: 'p' }) }, { actor: 'ui' })
  svc.execute('task.upsert', { task: richTask('c2', { parentId: 'p' }) }, { actor: 'ui' })

  svc.execute('task.reorder', { ids: ['c2', 'c1', 'p'] }, { actor: 'ui' })
  svc.execute('task.archive', { id: 'p' }, { actor: 'ui' })

  const list = svc.execute('task.list', {}, {})
  assert.equal(list.find((t) => t.id === 'c1').parentId, 'p', '排序后父子关系保持')
  assert.equal(list.find((t) => t.id === 'c2').parentId, 'p', '归档后父子关系保持')
}))

test('未知 id 归档报 not-found，不静默忽略', () => withService((svc) => {
  svc.execute('task.upsert', { task: richTask('a') }, { actor: 'ui' })
  assert.throws(
    () => svc.execute('task.archive', { ids: ['a', 'ghost'] }, { actor: 'ui' }),
    (e) => e?.code === 'not-found',
  )
}))

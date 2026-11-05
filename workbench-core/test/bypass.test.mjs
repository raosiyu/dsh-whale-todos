/**
 * 审批绕过攻击测试 + 写方法旁路封堵验证。
 *
 * 用户要求「四类审批绕过攻击全部被拦截」：
 * 1. 伪造布尔授权（payload / meta 里的 `confirmed`）
 * 2. 伪造/复用凭证（未知 token、重放、篡改 target）
 * 3. 绕过业务入口直接调用底层写方法（`store` / `events` 暴露面）
 * 4. 利用 target 字符串歧义复用凭证
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorkbenchService,
  createHostApprovalGate,
  approvalFingerprint,
  ERROR_CODES,
  WorkbenchError,
} from '../src/index.js'

async function withSvc(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r3-attack-'))
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    ...opts,
  })
  try {
    return await fn(svc, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const mkEvent = (svc, title, day) =>
  svc.execute('event.create', {
    event: {
      title,
      allDay: false,
      start: `2026-11-0${day}T09:00`,
      end: `2026-11-0${day}T10:00`,
      timeZone: 'UTC',
    },
  }).event

const isConfirmRequired = (e) =>
  e instanceof WorkbenchError && e.code === ERROR_CODES.CONFIRMATION_REQUIRED

// ---------------------------------------------------------------- 攻击类 1：伪造布尔

test('攻击1：payload.confirmed 不能授权删除', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    assert.throws(
      () => svc.execute('event.delete', { id: ev.id, confirmed: true }, { confirmed: true }),
      isConfirmRequired,
    )
    assert.equal(svc.execute('event.list').length, 1, '事件必须还在')
  })
})

test('攻击1：meta.confirmed 不能授权删除', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    assert.throws(
      () => svc.execute('event.delete', { id: ev.id }, { confirmed: true }),
      isConfirmRequired,
    )
    assert.equal(svc.execute('event.list').length, 1)
  })
})

test('攻击1：嵌套 payload.meta.confirmed 不能授权', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    assert.throws(
      () => svc.execute('event.delete', { id: ev.id, meta: { confirmed: true } }, {}),
      isConfirmRequired,
    )
    assert.equal(svc.execute('event.list').length, 1)
  })
})

// ---------------------------------------------------------------- 攻击类 2：伪造/复用凭证

test('攻击2：未知 token 被拒', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    assert.throws(
      () => svc.execute('event.delete', { id: ev.id }, { approvalToken: 'deadbeef' }),
      isConfirmRequired,
    )
    assert.equal(svc.execute('event.list').length, 1)
  })
})

test('攻击2：空串 / null / 数字 token 全被拒', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    for (const bad of ['', null, 0, {}, []]) {
      assert.throws(
        () => svc.execute('event.delete', { id: ev.id }, { approvalToken: bad }),
        isConfirmRequired,
        `token=${JSON.stringify(bad)} 必须被拒`,
      )
    }
    assert.equal(svc.execute('event.list').length, 1)
  })
})

test('攻击2：重放已消费 token 被拒', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    const appr = await svc.requestApproval('event.delete', { target: ev.id })
    svc.execute('event.delete', { id: ev.id }, { approvalToken: appr.token })
    assert.equal(svc.execute('event.list').length, 0, '第一次应成功')

    const ev2 = mkEvent(svc, 'y', 2)
    assert.throws(
      () => svc.execute('event.delete', { id: ev2.id }, { approvalToken: appr.token }),
      isConfirmRequired,
      '重放必须被拒',
    )
    assert.equal(svc.execute('event.list').length, 1)
  })
})

test('攻击2：篡改 target 后使用凭证被拒', async () => {
  await withSvc(async (svc) => {
    const a = mkEvent(svc, 'A', 1)
    const b = mkEvent(svc, 'B', 2)
    const appr = await svc.requestApproval('event.delete', { target: a.id })
    assert.throws(
      () => svc.execute('event.delete', { id: b.id }, { approvalToken: appr.token }),
      isConfirmRequired,
    )
    assert.equal(svc.execute('event.list').length, 2, '两个事件都必须还在')
  })
})

test('攻击2：host 模式各种异常返回都 fail closed', async () => {
  const cases = [
    ['denied', async () => 'denied'],
    ['抛错', async () => { throw new Error('boom') }],
    ['undefined', async () => undefined],
    ['带空格 approved', async () => 'approved '],
    ['true', async () => true],
    ['对象', async () => ({ ok: true })],
  ]
  for (const [label, request] of cases) {
    const gate = createHostApprovalGate({ mode: 'host', request })
    const res = await gate.request({ op: 'event.delete', summary: 'x' })
    assert.equal(res.approved, false, `${label} 必须 fail closed`)
    assert.equal(res.token, undefined)
  }
})

test('攻击2：host 模式无 requester 时 fail closed', async () => {
  const gate = createHostApprovalGate({ mode: 'host' })
  const res = await gate.request({ op: 'event.delete', summary: 'x' })
  assert.equal(res.approved, false)
  assert.equal(res.reason, 'host-requester-missing')
})

// ---------------------------------------------------------------- 攻击类 3：绕过业务入口

test('攻击3：service 返回面不含任何写方法（旁路已封）', async () => {
  await withSvc(async (svc) => {
    const forbiddenStore = ['replace', 'rollback', 'commit', 'backup', 'mutate']
    for (const name of forbiddenStore) {
      assert.equal(svc.store[name], undefined, `store.${name} 不得暴露`)
    }
    const forbiddenEvents = ['remove', 'create', 'update', 'bulkDelete']
    for (const name of forbiddenEvents) {
      assert.equal(svc.events[name], undefined, `events.${name} 不得暴露`)
    }
    assert.equal(svc.approvalGate, undefined, 'gate 不得暴露')
  })
})

test('攻击3：只有只读方法保留，且真的只读', async () => {
  await withSvc(async (svc) => {
    mkEvent(svc, '只读验证', 1)
    assert.equal(typeof svc.store.listBackups, 'function')
    assert.equal(typeof svc.store.listPreBackups, 'function')
    assert.equal(typeof svc.events.list, 'function')
    assert.equal(typeof svc.events.get, 'function')
    assert.ok(Array.isArray(svc.store.listPreBackups()))
    assert.equal(svc.events.list().length, 1)
    // 只读投影被 freeze，挂不上新的写方法
    assert.equal(Object.isFrozen(svc.store), true, 'store 投影应被冻结')
    assert.equal(Object.isFrozen(svc.events), true, 'events 投影应被冻结')
  })
})

test('攻击3：删除/替换/回滚都必须经过审批（无凭证一律拒）', async () => {
  await withSvc(async (svc) => {
    const ev = mkEvent(svc, 'x', 1)
    assert.throws(() => svc.execute('event.delete', { id: ev.id }), isConfirmRequired)
    assert.throws(() => svc.execute('snapshot.replace', { text: '{}' }), isConfirmRequired)
    assert.throws(() => svc.execute('store.rollback', { name: 'x-pre-1.json' }), isConfirmRequired)
    assert.throws(() => svc.execute('event.bulkDelete', { ids: [ev.id] }), isConfirmRequired)
    assert.throws(() => svc.execute('event.import', { text: 'x' }), isConfirmRequired)
  })
})

// ---------------------------------------------------------------- 攻击类 4：target 歧义

test('攻击4：bulkDelete 的 target 使用 JSON 而非逗号拼接（无歧义）', async () => {
  await withSvc(async (svc) => {
    const a = mkEvent(svc, 'A', 1)
    const b = mkEvent(svc, 'B', 2)
    // 若仍用 join(',')，则 target='a,b' 与 ids:[a,b] 会撞车。
    // 现在 target 是 JSON.stringify(sortedIds)，需要精确匹配。
    const appr = await svc.requestApproval('event.bulkDelete', { ids: [a.id, b.id] })
    assert.equal(appr.approved, true)
    const res = svc.execute('event.bulkDelete', { ids: [a.id, b.id] }, { approvalToken: appr.token })
    assert.equal(res.deleted.length, 2)
  })
})

test('攻击4：target 为逗号拼接串时不能用于 ids 数组', async () => {
  await withSvc(async (svc) => {
    const a = mkEvent(svc, 'A', 1)
    const b = mkEvent(svc, 'B', 2)
    // 手工申请一个「逗号拼接」的旧式 target
    const appr = await svc.requestApproval('event.bulkDelete', { target: `${a.id},${b.id}` })
    assert.throws(
      () => svc.execute('event.bulkDelete', { ids: [a.id, b.id] }, { approvalToken: appr.token }),
      isConfirmRequired,
      '逗号拼接的 target 不得匹配 ids 数组',
    )
    assert.equal(svc.execute('event.list').length, 2)
  })
})

test('攻击4：指纹对不同 id 集合严格区分', () => {
  const ids1 = ['a', 'b']
  const ids2 = ['a,b']
  const f1 = approvalFingerprint({ op: 'event.bulkDelete', target: JSON.stringify([...ids1].sort()) })
  const f2 = approvalFingerprint({ op: 'event.bulkDelete', target: JSON.stringify([...ids2].sort()) })
  assert.notEqual(f1, f2, '["a","b"] 与 ["a,b"] 指纹必须不同')
})

// ---------------------------------------------------------------- 审批矩阵

test('审批矩阵：5 个危险操作无凭证一律拒，有凭证一律放行', async () => {
  const ops = [
    ['event.delete', () => ({ id: 'x' })],
    ['event.bulkDelete', () => ({ ids: ['x'] })],
    ['event.import', () => ({ text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' })],
    ['snapshot.replace', () => ({ text: '{"events":[]}' })],
    ['store.rollback', () => ({ name: 'target-backup.json' })],
  ]
  for (const [op, payloadOf] of ops) {
    await withSvc(async (svc) => {
      const payload = payloadOf()
      assert.throws(
        () => svc.execute(op, payload),
        isConfirmRequired,
        `${op} 无凭证必须拒绝`,
      )
      const appr = await svc.requestApproval(op, {
        ...(payload.text === undefined ? {} : { text: payload.text }),
        ...(payload.ids === undefined ? {} : { ids: payload.ids }),
        ...(payload.id === undefined ? {} : { target: payload.id }),
      })
      assert.equal(appr.approved, true, `${op} 应能取得凭证`)
    }, { approvalMode: 'isolated', allowIsolatedApproval: true })
  }
})

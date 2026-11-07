/**
 * WP5.2-P0 独立复审 · 核心探针（Lead 交叉验证）
 * 覆盖：往返一致 / 无碰撞 / v1 兼容安全 / 端到端不重复 / 隔离保留
 * import 冻结副本，不碰主仓库业务代码
 */
import {
  reminderIdentity, decodeIdentity, ownershipOf, createReminderSync,
  encodePrompt, identityOfHostRecord, IDENTITY_FORMAT_V2,
} from '/tmp/wp52-p0-freeze-246e401/workbench-core/src/reminder-sync.js'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- R1 往返一致 + 无碰撞
console.log('R1 · 任意 scope/entityId 往返一致且无碰撞')
{
  const scopes = ['', '_', 'a::b', 'proj:sub', 'x:y:z', '中文:作用域', 'emoji🙂', ']]', '[[wb:', 'a\nb', 'a\u0000b', 'x'.repeat(500)]
  const ids = ['t1', 'a::b', 'id:with:colons', '中文id', 'x.y', 'a]]b', 't1\nx', 't1.x', '']
  let roundtripOk = true
  for (const sc of scopes) for (const eid of ids) {
    const d = decodeIdentity(reminderIdentity('task', eid, sc))
    if (d === null || d.scope !== sc || d.entityId !== eid || d.legacyAmbiguous === true) roundtripOk = false
  }
  check('R1.1 全组合往返一致', roundtripOk)
  check('R1.2 空 scope 与 "_" 可区分',
    reminderIdentity('task','t1','') !== reminderIdentity('task','t1','_'))
  check('R1.3 旧格式会撞的 "scope=a,id=b:c" vs "scope=a:b,id=c" 不再撞',
    reminderIdentity('task','b:c','a') !== reminderIdentity('task','c','a:b'))
  check('R1.4 带版本前缀 + 段数=4',
    reminderIdentity('task','t1','a::b').startsWith(IDENTITY_FORMAT_V2 + '.')
    && reminderIdentity('task','t1','a::b').split('.').length === 4)
}

// ---- R2 v1 兼容安全
console.log('R2 · v1 旧格式兼容：歧义标 suspect，不误删')
{
  for (const raw of ['task:_:t1', 'task:t1', 'task:projA:a:b', 'task:a::b:t1']) {
    const d = decodeIdentity(raw)
    check(`R2.1 ${raw} 标 legacyAmbiguous`, d?.legacyAmbiguous === true, JSON.stringify(d))
  }
  check('R2.2 v1 歧义记录 ownershipOf 判 suspect',
    ownershipOf({ prompt: '\u200B\u2060[[wb:task:_:t1]]' }, { scope: '' }).level === 'suspect')
  check('R2.3 v2 干净记录判 owned',
    ownershipOf({ prompt: encodePrompt('x', reminderIdentity('task','t1')) }, { scope: '' }).level === 'owned')
}

// ---- R3 端到端不重复创建
console.log('R3 · 含冒号 scope 连续 reconcile 只 create 1 次')
{
  const NOW = Date.parse('2026-11-07T12:00:00.000Z')
  const FUTURE = '2026-12-01T10:00:00.000Z'
  const mkTask = (id, t) => ({ id, title: t, dueAt: FUTURE, done: false, status: 'planned' })
  function fake() {
    const rows = new Map(); let seq = 0; const calls = { create: 0, delete: 0 }
    return { rows, calls,
      async create(sid, req) { const id = 'f' + (++seq); rows.set(id, { id, title: req.title, prompt: req.prompt, scheduledAt: req.at, sessionId: sid, status: 'active' }); calls.create++; return rows.get(id) },
      async catalog() { return [...rows.values()] },
      async update() { return { updated: true } },
      async delete(req) { calls.delete++; const r = rows.get(req.id); if (!r || r.sessionId !== req.sessionId) return { deleted: false }; rows.delete(req.id); return { deleted: true } },
      async history() { return { records: [], earlierRecordsUnavailable: false } },
    }
  }
  for (const scope of ['a::b', 'proj:sub', '中文:作用域', '']) {
    const s = fake()
    const sync = createReminderSync({ schedule: s, now: () => NOW })
    const data = { tasks: [mkTask('t1', 'A')] }
    const r1 = await sync.reconcile('s1', data, scope)
    const r2 = await sync.reconcile('s1', data, scope)
    const r3 = await sync.reconcile('s1', data, scope)
    check(`R3.1 scope=${JSON.stringify(scope)} 只 create 1 次`,
      r1.created === 1 && r2.created === 0 && r3.created === 0 && s.calls.create === 1 && s.rows.size === 1)
  }
}

// ---- R4 v1 坏记录保守处置
console.log('R4 · v1 坏记录：不误删 + 上报 + 不反复创建')
{
  const NOW = Date.parse('2026-11-07T12:00:00.000Z')
  const FUTURE = '2026-12-01T10:00:00.000Z'
  const mkTask = (id, t) => ({ id, title: t, dueAt: FUTURE, done: false, status: 'planned' })
  const rows = new Map([['old1', { id: 'old1', title: '旧', prompt: '正文 \u200B\u2060[[wb:task:a::b:t1]]', scheduledAt: FUTURE, sessionId: 's1', status: 'active' }]])
  let seq = 0; const calls = { create: 0, delete: 0 }
  const s = { rows, calls,
    async create(sid, req) { const id = 'n' + (++seq); rows.set(id, { id, title: req.title, prompt: req.prompt, scheduledAt: req.at, sessionId: sid, status: 'active' }); calls.create++; return rows.get(id) },
    async catalog() { return [...rows.values()] },
    async update() { return { updated: true } },
    async delete(req) { calls.delete++; const r = rows.get(req.id); if (!r || r.sessionId !== req.sessionId) return { id: req.id, deleted: false, code: 'schedule_not_found' }; rows.delete(req.id); return { id: req.id, deleted: true } },
    async history() { return { records: [], earlierRecordsUnavailable: false } },
  }
  const sync = createReminderSync({ schedule: s, now: () => NOW })
  const data = { tasks: [mkTask('t1', 'A')] }
  const r1 = await sync.reconcile('s1', data, 'a::b')
  const r2 = await sync.reconcile('s1', data, 'a::b')
  check('R4.1 v1 坏记录不删除', s.rows.has('old1'))
  check('R4.2 legacyMigrated=0', r1.legacyMigrated === 0)
  check('R4.3 legacyKept 上报 v1-boundary-lost',
    r1.legacyKept.some((x) => x.reason === 'v1-boundary-lost'))
  check('R4.4 不因旧记录存在而反复创建', r1.created === 1 && r2.created === 0 && s.calls.create === 1)
}

console.log('')
console.log(`核心探针汇总: PASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1

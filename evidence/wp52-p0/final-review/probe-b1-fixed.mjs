/**
 * B1 修复后验证（针对冻结 07d401f）
 * 核心：跨 scope 的 v1 旧记录绝不被删；含冒号 scope 幂等仍成立
 */
import { createReminderSync } from '/tmp/wp52-p0-freeze-07d401f/workbench-core/src/reminder-sync.js'
const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const FUTURE = '2026-12-01T10:00:00.000Z'
const mkTask = (id, t) => ({ id, title: t, dueAt: FUTURE, done: false, status: 'planned' })
let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}${d?' — '+d:''}`) } else { fail++; console.log(`  FAIL  ${n}${d?' — '+d:''}`) } }

// 场景1：跨 scope 误删（B1 原始复现）
{
  const rows = new Map([['old-empty', { id: 'old-empty', title: '空scope旧', prompt: '正文 \u200B\u2060[[wb:task:t1]]', scheduledAt: FUTURE, sessionId: 's1', status: 'active' }]])
  let seq = 0; const calls = { create: 0, delete: 0 }
  const s = { rows, calls,
    async create(sid, req) { const id = 'n' + (++seq); rows.set(id, { id, title: req.title, prompt: req.prompt, scheduledAt: req.at, sessionId: sid, status: 'active' }); calls.create++; return rows.get(id) },
    async catalog() { return [...rows.values()] },
    async update() { return { updated: true } },
    async delete(req) { calls.delete++; const r = rows.get(req.id); if (!r || r.sessionId !== req.sessionId) return { deleted: false, code: 'schedule_not_found' }; rows.delete(req.id); return { deleted: true } },
    async history() { return { records: [], earlierRecordsUnavailable: false } },
  }
  const sync = createReminderSync({ schedule: s, now: () => NOW })
  const r = await sync.reconcile('s1', { tasks: [mkTask('t1', 'A')] }, 'projA')
  check('B1.1 跨 scope reconcile 不删空 scope 旧记录', rows.has('old-empty'))
  check('B1.2 对旧记录零 delete 调用', s.calls.delete === 0)
  check('B1.3 仍建 v2 新记录', r.created === 1)
}

// 场景2：含冒号 scope 幂等（P0 本体仍成立）
{
  const rows = new Map(); let seq = 0; const calls = { create: 0, delete: 0 }
  const s = { rows, calls,
    async create(sid, req) { const id = 'n' + (++seq); rows.set(id, { id, title: req.title, prompt: req.prompt, scheduledAt: req.at, sessionId: sid, status: 'active' }); calls.create++; return rows.get(id) },
    async catalog() { return [...rows.values()] },
    async update() { return { updated: true } },
    async delete(req) { calls.delete++; rows.delete(req.id); return { deleted: true } },
    async history() { return { records: [], earlierRecordsUnavailable: false } },
  }
  const sync = createReminderSync({ schedule: s, now: () => NOW })
  const data = { tasks: [mkTask('t1', 'A')] }
  const r1 = await sync.reconcile('s1', data, 'a::b')
  const r2 = await sync.reconcile('s1', data, 'a::b')
  const r3 = await sync.reconcile('s1', data, 'a::b')
  check('B1.4 含冒号 scope 三次 reconcile create=1,0,0',
    r1.created === 1 && r2.created === 0 && r3.created === 0 && s.rows.size === 1)
}

console.log(`B1 修复验证汇总: PASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1

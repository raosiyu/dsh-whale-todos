/**
 * ROUND 2 独立复审 · 探针 V1 + 重启：v1 兼容安全 + 白名单持久化跨进程重启
 *
 * 冻结副本：/tmp/wp52-p0-freeze-07d401f（commit 07d401f）
 */
import {
  createReminderSync,
  reminderIdentity,
  encodePrompt,
  decodeIdentity,
  ownershipOf,
} from '/tmp/wp52-p0-freeze-07d401f/workbench-core/src/reminder-sync.js'

let pass = 0, fail = 0
function check(label, cond, d = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`) }
  else { fail += 1; console.log(`  ❌ ${label}  ${d}`) }
}

console.log('=== V1: decodeIdentity 歧义标 legacyAmbiguous；ownershipOf 判 suspect（不删）===')
const v1Cases = [
  ['task:_:t1',      'legacyAmbiguous', true],
  ['task:t1',        'legacyAmbiguous', true],
  ['task:projA:a:b', 'legacyAmbiguous', true],
  ['task:a::b:t1',   'legacyAmbiguous', true],
  ['event-start:_:e1','legacyAmbiguous', true],
]
for (const [ident, field, expected] of v1Cases) {
  const d = decodeIdentity(ident)
  const ambiguous = d?.legacyAmbiguous === true
  const own = ownershipOf({ prompt: `x \u200B\u2060[[wb:${ident}]]` }, { scope: '' })
  check(`decodeIdentity(${JSON.stringify(ident)}) → legacyAmbiguous=${ambiguous}, ownershipOf=${own.level}`,
    ambiguous === expected && own.level === 'suspect',
    `ambiguous=${ambiguous} level=${own.level} reason=${own.reason}`)
}

console.log('\n=== V1: v2 干净记录判 owned（不受误伤） ===')
{
  const v2 = reminderIdentity('task', 't1', 'projA')
  const own = ownershipOf({ prompt: encodePrompt('x', v2) }, { scope: 'projA' })
  check(`v2 干净记录 (scope=projA) 判 owned`, own.level === 'owned',
    `level=${own.level} identity=${own.identity}`)
  // 对照：scope 不匹配时判 suspect
  const own2 = ownershipOf({ prompt: encodePrompt('x', v2) }, { scope: 'other' })
  check(`v2 记录 scope 不匹配时判 suspect（不误当 owned）`, own2.level === 'suspect',
    `level=${own2.level} reason=${own2.reason}`)
}

console.log('\n=== RESTART: 白名单持久化后跨进程重启 create=0 ===')
{
  function fakeSchedule(seedRows = []) {
    let seq = 100
    const rows = new Map(seedRows)
    const calls = { create: [], delete: [], update: [] }
    return {
      calls, rows,
      async create(sessionId, req) {
        calls.create.push({ sessionId, req })
        const id = `schedule-fake-${++seq}`
        rows.set(id, { id, kind: 'at', title: req.title, prompt: req.prompt,
          scheduledAt: new Date(Date.parse(req.at)).toISOString(), sessionId, status: 'active' })
        return rows.get(id)
      },
      async catalog() { return [...rows.values()] },
      async update(req) {
        calls.update.push(req)
        const row = rows.get(req.id)
        if (row === undefined) return { id: req.id, updated: false, code: 'schedule_not_found' }
        if (row.sessionId !== req.sessionId) return { id: req.id, updated: false, code: 'schedule_not_found' }
        return { id: req.id, updated: true }
      },
      async delete(req) {
        calls.delete.push(req)
        const row = rows.get(req.id)
        if (row === undefined) return { id: req.id, deleted: false, code: 'schedule_not_found' }
        if (row.sessionId !== req.sessionId) return { id: req.id, deleted: false, code: 'schedule_not_found' }
        rows.delete(req.id)
        return { id: req.id, deleted: true }
      },
      async history() { return { records: [], earlierRecordsUnavailable: false } },
    }
  }

  const NOW = Date.parse('2026-11-07T12:00:00.000Z')
  const FUTURE = '2026-11-08T12:00:00.000Z'
  const mkTask = (id) => ({ id, dueAt: FUTURE, done: false, status: 'planned' })

  const scope = 'a::b'
  // 持久化白名单：跨「进程」共享一个 disk Map
  const disk = new Map()
  const ownershipFor = (sid, sc) => ({
    load: () => disk.get(`${sid}|${sc}`) ?? [],
    save: (ids) => disk.set(`${sid}|${sc}`, [...ids]),
  })

  // 进程 1：首次 reconcile 建 1 条，白名单写盘
  const s1 = fakeSchedule()
  const sync1 = createReminderSync({ schedule: s1, now: () => NOW, ownershipFor })
  const r1 = await sync1.reconcile('s1', { tasks: [mkTask('t1')] }, scope)

  // 进程 2（重启）：全新 fakeSchedule 但把 Host 已有记录搬过来（模拟 schedule.json 持久化）
  const persistedRows = [...s1.rows.entries()]
  const s2 = fakeSchedule(persistedRows)
  const sync2 = createReminderSync({ schedule: s2, now: () => NOW, ownershipFor })
  const r2 = await sync2.reconcile('s1', { tasks: [mkTask('t1')] }, scope)

  check(`重启后 created=0 且 Host 仍 1 条（scope=${JSON.stringify(scope)}）`,
    r1.created === 1 && r2.created === 0 && s2.rows.size === 1,
    `r1.created=${r1.created} r2.created=${r2.created} rows=${s2.rows.size}`)
  check(`白名单已持久化（disk 有 1 条 identity）`,
    (disk.get(`s1|${scope}`) ?? []).length === 1,
    `disk size=${(disk.get(`s1|${scope}`) ?? []).length}`)
}

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) process.exit(1)

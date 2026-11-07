/**
 * WP5.2 独立审查 Agent B · 探针 4（对抗性）：含冒号 scope 的生产链路重复注册
 *
 * 背景：probe-dedup Q3.4/Q3.5 发现 decodeIdentity 的 `([^:]*)` 只吃第一段，
 *       含冒号 scope 时自家记录被判 suspect/scope-mismatch → 被 ownHostRecords
 *       排除 → 每轮 reconcile 都 toCreate。本探针验证这条路径在**生产链路**可达，
 *       且每次写操作都会在 Host 上多堆一条 active 提醒（重复注册 → 重复投递）。
 *
 * 链路：
 *   parseWorkbenchRequest(JSON) → scope 无校验（可达性）
 *   createWorkbenchHostService.invoke(写 task) → forSession(sessionId, scope)
 *   createReminderSync.reconcile(sessionId, {tasks,events}, scope) → Host create
 *
 * 只读业务代码；不修改任何冻结/主仓库文件。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseWorkbenchRequest } from '/tmp/wp52-freeze-e9b2b32/packages/workbench-ui/index.js'
import { createWorkbenchHostService } from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/host-service.js'
import { createReminderSync, identityOfHostRecord, encodePrompt } from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/reminder-sync.js'

const NOW = Date.parse('2026-11-07T00:00:00.000Z')
const FUTURE = '2026-11-08T12:00:00.000Z'
const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }

function makeSchedule() {
  const rows = new Map()
  let seq = 0
  const created = []
  return {
    _rows: rows, created,
    async catalog() { return [...rows.values()].map((r) => ({ ...r })) },
    async create(sessionId, rec) {
      const id = `schedule-${++seq}`
      created.push({ id, sessionId, at: rec.at, prompt: rec.prompt })
      rows.set(id, { id, sessionId, ...rec, scheduledAt: rec.at, status: 'active' })
      return { id, kind: 'at', scheduledAt: rec.at }
    },
    async update(req) {
      const row = rows.get(req.id)
      if (row === undefined) return { updated: false, code: 'schedule_not_found' }
      Object.assign(row, { title: req.title, prompt: req.prompt, scheduledAt: req.change.at })
      return { id: req.id, updated: true }
    },
    async delete(req) { rows.delete(req.id); return { id: req.id, deleted: true } },
    async history() { return { records: [] } },
  }
}

// ---------------------------------------------------------------------------
hr('S1 可达性：parseWorkbenchRequest 是否放行含冒号 scope')
// ---------------------------------------------------------------------------
{
  for (const scope of ['projA', 'a::b', 'x:y:z', 'proj:sub', '', '日常/工作']) {
    const raw = JSON.stringify({ op: 'task.upsert', scope, payload: { task: { id: 't1', title: 'A', dueAt: FUTURE } } })
    const parsed = parseWorkbenchRequest(raw)
    const got = parsed.error === undefined ? parsed.req.scope : `ERROR:${parsed.error.code}`
    line(`  scope=${JSON.stringify(scope)} → ${JSON.stringify(got)}`)
    assert(parsed.error === undefined && parsed.req.scope === scope,
      `scope=${JSON.stringify(scope)} 被原样放行（无校验/无白名单）`)
  }
}

// ---------------------------------------------------------------------------
hr('S2 生产链路：含冒号 scope 连续写操作 → Host 累积 active 提醒')
// ---------------------------------------------------------------------------
async function runScenario(scope, label) {
  const root = mkdtempSync(join(tmpdir(), 'wp52-b-scope-'))
  const sched = makeSchedule()
  const stores = new Map()
  const ownershipFor = (sid, sc) => {
    const k = `${sid}\u0000${sc}`
    if (!stores.has(k)) stores.set(k, new Set())
    const ids = stores.get(k)
    return { load: () => [...ids], save: (a) => { ids.clear(); for (const x of a) ids.add(x) } }
  }
  const host = createWorkbenchHostService({ rootDir: root })
  const sync = createReminderSync({ schedule: sched, now: () => NOW, ownershipFor })
  try {
    const sid = 'session-scope-probe'
    // 模拟 UI：一次写操作 + 成功后对齐（index.js:338-355 的等价逻辑）
    const writeAndReconcile = async (task) => {
      host.invoke(sid, 'task.upsert', { task }, { scope })
      const svc = host.forSession(sid, scope)
      const tasks = svc.execute('task.list', {}, {})
      const events = svc.execute('event.list', {}, {})
      return sync.reconcile(sid, { tasks, events }, scope)
    }
    const r1 = await writeAndReconcile({ id: 't1', title: '买牛奶', dueAt: FUTURE })
    const r2 = await writeAndReconcile({ id: 't1', title: '买牛奶', dueAt: FUTURE }) // 同一条，无变化
    const r3 = await writeAndReconcile({ id: 't1', title: '买牛奶', dueAt: FUTURE }) // 再无变化
    const rows = [...sched._rows.values()]
    line(`[${label}] scope=${JSON.stringify(scope)}`)
    line(`  r1.created=${r1.created} r2.created=${r2.created} r3.created=${r3.created}`)
    line(`  Host active 条数=${rows.length}  create 调用=${sched.created.length}`)
    line(`  Host identities=${JSON.stringify(rows.map((r) => identityOfHostRecord(r)))}`)
    line(`  observed(r3)=${JSON.stringify(r3.observed)}`)
    return { rows: rows.length, creates: sched.created.length }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

{
  const normal = await runScenario('projA', '正常 scope')
  assert(normal.rows === 1 && normal.creates === 1, '正常 scope：3 次写操作只 1 条 Host 提醒（幂等）')

  const colon = await runScenario('a::b', '含冒号 scope')
  line(`>>> 判定：含冒号 scope 3 次写操作 → ${colon.rows} 条 active 提醒 / ${colon.creates} 次 create`)
  if (colon.rows > 1 && colon.creates > 1) {
    line(`[FINDING-P0] 含冒号 scope 下同一 identity 每轮写操作都重复 create：`)
    line(`  每次 create 生成不同 id、相同 scheduledAt 的 active 任务。`)
    line(`  依 02-delivery.md §1.2：Host drive() 每次扫描全表 scheduledAt<=now，`)
    line(`  这 ${colon.rows} 条 active 任务到点会各自投递 → 同一提醒重复投递 ${colon.rows} 次。`)
    line(`  且由于自家记录恒被判 suspect，白名单与 observed 无法收敛，孤儿只增不减。`)
    process.exitCode = 2 // 2 = 发现真实缺陷（区别于脚本错误 1）
  }
  assert(colon.rows === 1 && colon.creates === 1,
    '含冒号 scope 连续写操作不应重复 create（此断言预期 FAIL，用于暴露缺陷）')
}

// ---------------------------------------------------------------------------
hr('S3 投递语义佐证：这些重复行是否都满足「到点会被投递」的条件')
// ---------------------------------------------------------------------------
{
  // 构造两条「重复注册」出来的行，核对 drive() 的判据（scheduledAt <= now + active）
  const a = { id: 'schedule-1', status: 'active', scheduledAt: FUTURE, prompt: encodePrompt('买牛奶', 'task:a::b:t1') }
  const b = { id: 'schedule-2', status: 'active', scheduledAt: FUTURE, prompt: encodePrompt('买牛奶', 'task:a::b:t1') }
  const nowAfterDue = Date.parse(FUTURE) + 1
  const due = (r) => r.status === 'active' && Date.parse(r.scheduledAt) <= nowAfterDue
  line(`  行A due=${due(a)} 行B due=${due(b)}（同一到点时刻，两个不同 id）`)
  line(`  依据 02-delivery.md §1.2 drive() 扫全表 scheduledAt<=Date.now()，无 identity 去重：`)
  line(`  → 两条都满足 due 条件，会各自 resolveAgent(session).followup(message) 投递。`)
  line(`  结论：重复注册 = 重复投递（在本 Host 投递模型下）。`)
}

line('\n=== probe-scope-colon 结束 ===')

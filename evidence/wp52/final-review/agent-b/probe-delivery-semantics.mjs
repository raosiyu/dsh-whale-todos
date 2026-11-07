/**
 * WP5.2 独立审查 Agent B · 探针 7：重复注册 → 重复投递 的一手源码佐证
 *
 * 依据 @deepseek-ai/dsh-schedule/lib/index.js（asar 一手源码，本会话实读）：
 *   - drive() L1249: due = tasks().filter(t => status==="active" && scheduledAt<=scanNow)
 *                    → 全表按任务逐条扫描，无 prompt/identity 去重
 *   - drive() L1252/1255: handled 去重键是 task.record.id（不是 prompt）
 *   - drive() L1253-1254: group = batchSessionOf(task)===undefined ? [task] : ...
 *   - batchSessionOf L1106-1108: 仅 target.kind==="session" && isRecurring 才 batch；
 *                    一次性 `at` 任务返回 undefined → 单条 group
 *   - deliverDue L1308: 每个 group 各调一次 send(agent,text,held) → 一条 user/message
 *   - deliverDue L1310-1318: group 内每个 member 各自 commit（不同 record.id）
 *
 * WP5.2 提醒是 create(...,{at}) / change:{kind:'at'} 的一次性任务 → 每条重复
 * 注册都是独立 group → 到点各发一条 user/message = 真实重复投递。
 *
 * 本探针把上述源码行抽出来核对（asar 主目录本会话期间被外部清理，
 * 用仍存在的副本 /private/tmp/wp4r3/asar 复核同一段源码）。
 * 只读，不修改任何业务代码。
 */
import { readFileSync, existsSync } from 'node:fs'

const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }

const CANDIDATES = [
  '/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js',
  '/private/tmp/wp4r3/asar/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js',
  '/private/tmp/wp2r3rev/asar_full/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js',
]
const src = CANDIDATES.find((p) => existsSync(p))
line(`  使用一手源码: ${src ?? 'NONE'}`)
assert(src !== undefined, '至少有一份 dsh-schedule 一手源码可核对')
const code = readFileSync(src, 'utf8')

hr('D1 drive() 全表扫描 + 按 record.id 去重（不是按 prompt/identity）')
{
  const hasFilter = /due = this\.tasks\(\)\.filter\(\(task\) => task\.status === "active"/.test(code)
    || /this\.tasks\(\)\.filter\(\(task\) => task\.status === "active"[\s\S]{0,200}scheduledAt\) <= scanNow/.test(code)
  const hasIdDedup = /handled\.has\(task\.record\.id\)/.test(code)
    && /handled\.add\(member\.record\.id\)/.test(code)
  const hasGroupBySession = /const group = session === void 0 \? \[task\] : due\.filter/.test(code)
  line(`  drive 全表 active 扫描=${hasFilter}  handled 去重键=record.id=${hasIdDedup}  group 分流=${hasGroupBySession}`)
  assert(hasFilter && hasIdDedup && hasGroupBySession,
    'drive() 按 task.record.id 逐条处理，重复注册的不同 id 不会被合并')
}

hr('D2 batchSessionOf：一次性 at 任务不 batch（各自独立投递）')
{
  const hasFn = /function batchSessionOf\(task\) \{[\s\S]{0,200}target\.kind === "session" && isRecurringScheduleRecord\(record\)/.test(code)
  line(`  batchSessionOf 仅对 recurring session 任务返回 sessionId=${hasFn}`)
  assert(hasFn, '一次性 at 任务 batchSessionOf→undefined → group=[task] → 独立 send()')

  // WP5.2 提醒用的 create/change 形态（reminder-sync.js L642-646 / L678）。
  // 注：冻结副本 /tmp/wp52-freeze-e9b2b32 在本会话后期被外部流程清理；
  // 此处退回主仓库同一未修改文件（git status 空、字节数 32118 与冻结副本一致、
  // 行号 642/645/678 完全对应）。所有行为探针已在冻结副本存在时跑完并固化日志。
  const SYNC_CANDIDATES = [
    '/tmp/wp52-freeze-e9b2b32/workbench-core/src/reminder-sync.js',
    '../../../../workbench-core/src/reminder-sync.js',
  ]
  const syncPath = SYNC_CANDIDATES.find((p) => existsSync(p))
  line(`  reminder-sync 源码: ${syncPath ?? 'NONE'}`)
  const syncSrc = readFileSync(syncPath, 'utf8')
  const createIsAt = /schedule\.create\(sessionId, \{[\s\S]{0,200}at: new Date\(want\.fireAtMs\)\.toISOString\(\)/.test(syncSrc)
  const updateIsAt = /change: \{ kind: 'at', at: new Date\(item\.want\.fireAtMs\)\.toISOString\(\) \}/.test(syncSrc)
  line(`  reminder-sync create 用 at=${createIsAt} update 用 kind:'at'=${updateIsAt}`)
  assert(createIsAt && updateIsAt, 'WP5.2 提醒是一次性 at 任务（非 recurring）→ 不 batch')
}

hr('D3 结论链')
{
  line(`  含冒号 scope（probe-scope-colon 实证 3 次写 → 3 条 active 提醒，不同 id、同 scheduledAt）`)
  line(`  + drive() 全表扫 active、按 record.id 去重、at 任务不 batch（一手源码）`)
  line(`  + deliverDue 每个 group 一次 send() → 每个 group 一条 user/message`)
  line(`  = 到点后同一提醒内容产生 3 条独立 user/message → 真实重复投递（P0）`)
  line(`  注：不是「一条 batch 消息里列 3 条」——那需要 recurring + target.kind==="session"，`)
  line(`      本插件的 at 任务不满足，故不合并。`)
}

line('\n=== probe-delivery-semantics 结束 ===')

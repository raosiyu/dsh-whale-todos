/**
 * WP5 UI 能力的可重复验证。
 *
 * 这里验证的是**服务端契约 + 审批红线**，不是「截图看着对」。
 * 每条断言都对应一个 UI 动作背后真正发生的事：
 * 排序有没有落盘、归档有没有复用软删、导入能不能绕过审批。
 *
 * 用法：node scripts/verify-wp5-ui.mjs <dataDir>
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkbenchService } from '../workbench-core/src/index.js'

const dataDir = process.argv[2]
if (dataDir === undefined || !existsSync(dataDir)) {
  console.error('用法：node scripts/verify-wp5-ui.mjs <dataDir>')
  process.exit(2)
}

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ', name, detail ?? '') }
  else { fail++; console.log('FAIL ', name, detail ?? '') }
}

/**
 * 本脚本**自建数据**，不依赖任何外部种子。
 *
 * 原实现直接读 dataDir 里已有的 WP5 分组待办 —— 换个空目录就全 FAIL，
 * 换个脏目录又可能假绿。可重复验证的前提是「输入由脚本自己决定」。
 * 写操作需要审批门放行，所以这里用 host 模式；审批红线那一条单独
 * 用 deny 模式的实例验证，两件事不能混在一个实例里。
 */
const svc = createWorkbenchService({ dataDir, approvalMode: 'host', allowIsolatedApproval: true })

// 0. 建基准数据：两条同组待办（用于排序）+ 一条会被归档的待办 + 一个冲突源事件
await svc.execute('task.upsert', { task: { id: 'v-a', title: '校验A', project: 'WP5', order: 10 } })
await svc.execute('task.upsert', { task: { id: 'v-b', title: '校验B', project: 'WP5', order: 11 } })
await svc.execute('task.upsert', { task: { id: 'v-arc', title: '校验归档', project: 'WP5', order: 12 } })
// 先排一次序，让 order 真正落盘（也顺带验证 reorder 自身可用）
await svc.execute('task.reorder', { ids: ['v-b', 'v-a'], project: 'WP5' })
// 冲突源：与 fixture 的 2026-11-20 02:00Z 重叠
await svc.execute('event.create', {
  event: { title: '校验冲突源', allDay: false, start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00', timeZone: 'Asia/Shanghai' },
})

// 1. 排序落盘：order 字段必须真的写进文件
// task.list 直接返回任务数组（不是 {tasks}）——读错形状会得到「0 条」假绿
const list = await svc.execute('task.list', {})
const tasks = Array.isArray(list) ? list : (list.tasks ?? [])
const grouped = tasks.filter((t) => t.project === 'WP5' && t.archived !== true && t.deleted !== true)
const withOrder = grouped.filter((t) => typeof t.order === 'number')
ok('排序落盘', withOrder.length >= 2, `WP5 组内 ${withOrder.length} 条有 order`)

// 2. 归档不是软删
//    必须读**磁盘原文**：task.list 会把软删的行过滤掉，
//    用列表判断「有没有混用」永远是 0 条，等于空检查（变异探针抓到过）。
await svc.execute('task.archive', { id: 'v-arc' })
const raw = JSON.parse(readFileSync(join(dataDir, 'workbench.json'), 'utf8'))
const rawTasks = raw.tasks ?? []
const archived = rawTasks.filter((t) => t.archived === true)
const archivedButDeleted = archived.filter((t) => t.deleted === true)
ok('归档 ≠ 软删', archivedButDeleted.length === 0,
  `磁盘归档 ${archived.length} 条，其中软删 ${archivedButDeleted.length} 条`)

// 3. 撤销栈可用
const hs = await svc.execute('history.status', {})
ok('撤销可用', hs.canUndo === true, `undoDepth=${hs.undoDepth}`)

// 4. 导入预览分类（fixture 内联，不依赖外部临时文件）
//    原实现读 /tmp/import-test.ics，文件不在就静默跳过 —— 跳过没有计数、
//    没有提示，等于这条检查可以凭空消失。fixture 写进脚本本身。
const ICS_FIXTURE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//whale//verify//EN',
  // 这条与基准数据里的「校验冲突源」重叠 → 必须被判为 conflict
  'BEGIN:VEVENT',
  'UID:verify-conflict-001@whale',
  'DTSTAMP:20261101T000000Z',
  'DTSTART:20261120T020000Z',
  'DTEND:20261120T030000Z',
  'SUMMARY:校验用冲突事件',
  'END:VEVENT',
  // 这条落在没别的事的日期 → 必须被判为 create
  'BEGIN:VEVENT',
  'UID:verify-create-001@whale',
  'DTSTAMP:20261101T000000Z',
  'DTSTART:20261125T020000Z',
  'DTEND:20261125T030000Z',
  'SUMMARY:校验用新增事件',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')
{
  const pv = await svc.execute('event.previewIcs', { text: ICS_FIXTURE, defaultTimeZone: 'Asia/Shanghai' })
  const plan = pv.plan ?? []
  ok('ICS 预览有 create', plan.some((x) => x.action === 'create'), `${plan.length} 行计划`)
  ok('ICS 预览识别冲突', plan.some((x) => x.action === 'conflict'), '冲突行存在')
  ok('ICS 预览计数来自服务端',
    Number.isFinite(pv.counts?.create) && Number.isFinite(pv.counts?.unsupported),
    `counts=${JSON.stringify(pv.counts)}`)
}

/**
 * 5. 审批红线：无凭证导入必须被拒。
 *
 * 判据必须精确到「被审批门拦下」，不能是 `e.name === 'WorkbenchError'` ——
 * 那样任何 WorkbenchError（含 op 名拼错、参数校验失败）都会被当成
 * 「成功拦下」，实测 event.importt / nonsense 两个根本不存在的 op 都能
 * 让原判据 PASS。这是假绿。
 */
{
  const denySvc = createWorkbenchService({ dataDir: join(dataDir, 'deny-probe'), approvalMode: 'deny' })
  const probe = async (op) => {
    try { await denySvc.execute(op, { text: '{}' }); return { blocked: false, code: 'none' } }
    catch (e) { return { blocked: true, code: e.code ?? 'unknown', message: String(e.message ?? '') } }
  }
  const real = await probe('event.import')
  ok('导入不得绕过审批',
    real.blocked && real.code === 'confirmation-required' && /event\.import/.test(real.message),
    `${real.code} ${real.message.slice(0, 60)}`)
  // 反证：不存在的 op 必须报 unsupported，不能被判成「被审批拦下」
  const fake = await probe('event.importt')
  ok('审批判据不得把不存在的 op 当成已拦下',
    fake.code === 'unsupported',
    `event.importt → ${fake.code}（必须 unsupported，否则判据过宽）`)
}

// 6. AI 工具面没有导入执行入口（解析工具名集合，不做子串匹配）
{
  const toolsSrc = readFileSync(join(import.meta.dirname, '..', 'workbench-core', 'src', 'host-tools.js'), 'utf8')
  const names = new Set([...toolsSrc.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]))
  ok('AI 面只有预览',
    names.has('workbench_import_preview') && !names.has('workbench_import_apply'),
    `工具 ${names.size} 个，含 preview=${names.has('workbench_import_preview')} apply=${names.has('workbench_import_apply')}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

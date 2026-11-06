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

const svc = createWorkbenchService({ dataDir, approvalMode: 'deny' })

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
const raw = JSON.parse(readFileSync(join(dataDir, 'workbench.json'), 'utf8'))
const rawTasks = raw.tasks ?? []
const archived = rawTasks.filter((t) => t.archived === true)
const archivedButDeleted = archived.filter((t) => t.deleted === true)
ok('归档 ≠ 软删', archivedButDeleted.length === 0,
  `磁盘归档 ${archived.length} 条，其中软删 ${archivedButDeleted.length} 条`)

// 3. 撤销栈可用
const hs = await svc.execute('history.status', {})
ok('撤销可用', hs.canUndo === true, `undoDepth=${hs.undoDepth}`)

// 4. 导入预览分类
const icsPath = '/tmp/import-test.ics'
if (existsSync(icsPath)) {
  const text = readFileSync(icsPath, 'utf8')
  const pv = await svc.execute('event.previewIcs', { text, defaultTimeZone: 'Asia/Shanghai' })
  const plan = pv.plan ?? []
  ok('ICS 预览有 create', plan.some((x) => x.action === 'create'), `${plan.length} 行计划`)
  ok('ICS 预览识别冲突', plan.some((x) => x.action === 'conflict'), '冲突行存在')
}

// 5. 审批红线：无凭证导入必须被拒
let blocked = false
try {
  await svc.execute('event.import', { text: '{}' })
} catch (e) {
  blocked = e.code === 'confirmation-required' || e.name === 'WorkbenchError'
}
ok('导入不得绕过审批', blocked, '无 token 的 event.import 被拒')

// 6. AI 工具面没有导入执行入口
const toolsSrc = readFileSync(join(import.meta.dirname, '..', 'workbench-core', 'src', 'host-tools.js'), 'utf8')
ok('AI 面只有预览', toolsSrc.includes("name: 'workbench_import_preview'") && !toolsSrc.includes("name: 'workbench_import_apply'"),
  '存在 import_preview，不存在 import_apply')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

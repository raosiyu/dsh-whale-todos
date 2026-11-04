/**
 * 功能演示：在临时目录里跑一遍 Event 日历域的完整链路。
 *
 * 运行：node demo/demo.mjs
 * 不写用户数据（用 mkdtemp），不依赖网络，不安装任何插件。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createScheduleAdapter,
  createWorkbenchService,
  instantToWall,
  wallToInstant,
} from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-demo-'))
const svc = createWorkbenchService({
  dataDir: dir,
  defaultTimeZone: 'Asia/Shanghai',
  // 演示用隔离审批门：凭证由本进程签发，模拟「宿主批准后发凭证」。
  // 生产必须用 mode:'host'，由真实宿主 ctx.approval 决定。
  approvalMode: 'isolated',
  allowIsolatedApproval: true,
})
const log = (...args) => console.log(...args)
const at = (wall, tz = 'Asia/Shanghai') => wallToInstant(`${wall}:00`, tz).ms
const show = (ms, tz = 'Asia/Shanghai') => instantToWall(ms, tz).replace('T', ' ')

log('=== 数据目录 ===')
log(dir)
log('')

log('=== 1) 创建定时事件（重复：每周一/三，共 4 次）===')
const meeting = svc.execute('event.create', {
  event: {
    title: '产品周会',
    allDay: false,
    start: '2026-11-02T09:00',
    end: '2026-11-02T10:00',
    timeZone: 'Asia/Shanghai',
    recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'], count: 4 },
    importance: 'high',
    tags: ['会议'],
  },
})
log('created:', meeting.event.id, meeting.event.title)
log('')

log('=== 2) 创建全天事件 ===')
const holiday = svc.execute('event.create', {
  event: { title: '团队假期', allDay: true, startDate: '2026-11-05', endDate: '2026-11-07' },
})
log('created:', holiday.event.id, holiday.event.startDate, '→', holiday.event.endDate)
log('')

log('=== 3) 展开窗口内的实例（11/01–11/16）===')
const instances = svc.execute('event.expand', {
  windowStart: at('2026-11-01T00:00'),
  windowEnd: at('2026-11-16T00:00'),
})
for (const inst of instances) {
  log(`  ${inst.eventId.slice(0, 8)}  ${show(inst.startMs)} → ${show(inst.endMs)}  allDay=${inst.allDay}`)
}
log('')

log('=== 4) 冲突检测：插入一个与周会重叠的事件 ===')
try {
  svc.execute('event.create', {
    event: {
      title: '冲突的评审', allDay: false,
      start: '2026-11-02T09:30', end: '2026-11-02T10:30', timeZone: 'Asia/Shanghai',
    },
  })
  log('  意外：应当被拒绝')
} catch (error) {
  log(`  已按预期拒绝：${error.code} — ${error.message}`)
}
const overlap = svc.execute('event.create', {
  event: {
    title: '冲突的评审', allDay: false,
    start: '2026-11-02T09:30', end: '2026-11-02T10:30', timeZone: 'Asia/Shanghai',
  },
  allowOverlap: true,
})
log(`  allowOverlap 放行：${overlap.event.id}`)
log('')

log('=== 5) 空闲时段（11/02 08:00–18:00，最小 30 分钟）===')
const slots = svc.execute('event.freeSlots', {
  windowStart: at('2026-11-02T08:00'),
  windowEnd: at('2026-11-02T18:00'),
  minSlotMs: 30 * 60000,
})
for (const slot of slots.free) {
  log(`  空闲 ${show(slot.startMs)} → ${show(slot.endMs)}`)
}
log('')

log('=== 6) ICS 导出 → 预览导入 ===')
const ics = svc.execute('event.exportIcs', { calendarName: '演示日历' })
log(`  导出 ${ics.count} 条，前 3 行：`)
log(ics.text.split('\r\n').slice(0, 3).map((l) => `    ${l}`).join('\n'))
const preview = svc.execute('event.previewIcs', { text: ics.text })
log(`  预览：create=${preview.counts.create} skip=${preview.counts.skip}`)
log('')

log('=== 7) 危险操作审批门（confirmed 不再被采信）===')
try {
  svc.execute('event.delete', { id: meeting.event.id })
  log('  意外：无凭证也通过了')
} catch (error) {
  log(`  无凭证被拒：${error.code}`)
}
try {
  // 关键演示：AI 自己填 confirmed:true 也无效
  svc.execute('event.delete', { id: meeting.event.id, confirmed: true }, { confirmed: true })
  log('  意外：confirmed 竟然能绕过审批')
} catch (error) {
  log(`  伪造 confirmed 被拒：${error.code}`)
}
const approval = await svc.requestApproval('event.delete', { target: meeting.event.id })
log(`  宿主审批：approved=${approval.approved}，取得一次性凭证`)
const del = svc.execute('event.delete', { id: meeting.event.id }, { approvalToken: approval.token })
log(`  凭凭证删除成功：deletedAt=${del.deletedAt}`)
log('')

log('=== 8) 快照导出 / 替换 / 回滚 ===')
const snap = svc.execute('snapshot.export')
log(`  快照指纹：${snap.fingerprint.slice(0, 16)}…  事件数=${svc.execute('event.list').length}`)
const replaceApproval = await svc.requestApproval('snapshot.replace', { text: snap.text })
svc.execute('snapshot.replace', { text: snap.text }, { approvalToken: replaceApproval.token })
// 指纹绑定具体备份名（不再用 'latest'，避免审批后目标前移的 TOCTOU）
const preBackups = svc.store.listPreBackups()
const rollbackTarget = preBackups[preBackups.length - 1]
const rbApproval = await svc.requestApproval('store.rollback', { target: rollbackTarget })
const rb = svc.execute('store.rollback', { name: rollbackTarget }, { approvalToken: rbApproval.token })
log(`  回滚到：${rb.restored}`)
log('')

log('=== 9) 审计日志（最近 5 条）===')
for (const row of svc.execute('store.audit').slice(-5)) {
  log(`  ${row.at}  ${row.action}  ${row.entityId ?? '-'}`)
}
log('')

log('=== 10) Task 门面与 Event 隔离 ===')
svc.execute('task.upsert', { task: { id: 'task-1', title: '既有任务（未迁移）', statusCode: 'todo' } })
log(`  tasks=${svc.execute('task.list').length}  events=${svc.execute('event.list').length}`)
log('')

log('=== 11) 提醒系统：ScheduleAdapter + 幂等对账 ===')
const BASE = Date.UTC(2026, 10, 1, 0, 0, 0)
const adapter = createScheduleAdapter({
  backend: 'memory',                 // 演示用内存后端；生产接 ctx.schedule
  now: () => BASE,
  defaultLeadMinutes: 15,
})
const live = svc.execute('event.list')
const plans = adapter.planForEvents(live, {
  windowStart: BASE, windowEnd: BASE + 30 * 86400000,
})
log(`  为 ${live.length} 个事件编译出 ${plans.length} 条提醒`)
const rec1 = await adapter.reconcile(plans)
log(`  首次对账：created=${rec1.created.length} removed=${rec1.removed.length}`)
const rec2 = await adapter.reconcile(plans)
log(`  重复对账（幂等）：created=${rec2.created.length}（应为 0）`)

if (plans.length > 0) {
  const fireAt = plans[0].fireAtMs
  const first = adapter._tick(fireAt)
  const second = adapter._tick(fireAt + 60000)
  log(`  到点投递：第一次 ${first.length} 条，重复 tick ${second.length} 条（应为 0）`)
  const hist = await adapter.history()
  log(`  投递历史 ${hist.length} 条（与真实投递一致）`)
}

rmSync(dir, { recursive: true, force: true })
log('演示结束（临时目录已清理）')

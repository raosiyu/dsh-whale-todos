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
  createWorkbenchService,
  instantToWall,
  wallToInstant,
} from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-demo-'))
const svc = createWorkbenchService({ dataDir: dir, defaultTimeZone: 'Asia/Shanghai' })
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

log('=== 7) 危险操作审批门 ===')
try {
  svc.execute('event.delete', { id: meeting.event.id })
  log('  意外：应当要求确认')
} catch (error) {
  log(`  已按预期拒绝：${error.code}`)
}
const del = svc.execute('event.delete', { id: meeting.event.id }, { confirmed: true })
log(`  确认后删除：deletedAt=${del.deletedAt}`)
log('')

log('=== 8) 快照导出 / 替换 / 回滚 ===')
const snap = svc.execute('snapshot.export')
log(`  快照指纹：${snap.fingerprint.slice(0, 16)}…  事件数=${svc.execute('event.list').length}`)
svc.execute('snapshot.replace', { text: snap.text }, { confirmed: true })
const rb = svc.execute('store.rollback', {}, { confirmed: true })
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

rmSync(dir, { recursive: true, force: true })
log('演示结束（临时目录已清理）')

/**
 * WP5.1 · P1：ICS 幂等导入。
 *
 * ## 修的是什么（实测复现过）
 *
 * 原 `event.import` 逐条无条件 `events.create`，完全不查 UID。实测同一份
 * ICS 连续导入两次，事件数从 2 变成 4：
 *
 *   第一次导入 counts: {"imported":2, …}
 *   第二次导入 counts: {"imported":2, …}
 *   最终事件数: 4
 *   各条 uid: accept-ics-001, accept-ics-002, accept-ics-001, accept-ics-002
 *
 * 而 `event.previewIcs` **已经**正确标出 `skip-duplicate-uid` —— 也就是说
 * 「预览说要跳过、执行照样建」。修法是让两边共用同一个判重函数。
 *
 * ## 语义边界（必须锁住，否则修成另一种错）
 *
 * 1. 只按 **UID** 判重，不按标题/时间（同标题不同 UID 是两条不同的事件）；
 * 2. 已软删的事件**不参与**判重 —— 用户删掉后重新导入同一份文件，应当建回来；
 * 3. 同一次导入内部的自重复也要跳过（文件里有两条相同 UID）；
 * 4. 跳过必须**如实上报**，不能静默吞掉（用户要知道「导入了 1 条、跳过 1 条」）；
 * 5. 审批与失败回滚不受影响。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkbenchService } from '../src/index.js'

function withService(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-idem-'))
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
  })
  const result = fn(svc, dir)
  if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(dir, { recursive: true, force: true })
  return result
}

const TZ = 'Asia/Shanghai'

/** 造一份 N 条事件的 ICS。 */
function makeIcs(entries) {
  const head = 'BEGIN:VCALENDAR\nVERSION:2.0\n'
  const tail = 'END:VCALENDAR\n'
  const body = entries.map((e) => [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SUMMARY:${e.title}`,
    `DTSTART;TZID=${TZ}:${e.start}`,
    `DTEND;TZID=${TZ}:${e.end}`,
    'END:VEVENT',
  ].join('\n')).join('\n')
  return head + body + '\n' + tail
}

async function importIcs(svc, ics) {
  const token = await svc.requestApproval('event.import', { text: ics })
  return svc.execute('event.import', { text: ics, defaultTimeZone: TZ }, { actor: 'ui', approvalToken: token.token })
}

const TWO = makeIcs([
  { uid: 'idem-001', title: '幂等甲', start: '20261201T090000', end: '20261201T100000' },
  { uid: 'idem-002', title: '幂等乙', start: '20261202T090000', end: '20261202T100000' },
])

test('幂等：同一份 ICS 导入两次，不得重复创建（核心回归）', () => withService(async (svc) => {
  const r1 = await importIcs(svc, TWO)
  assert.equal(r1.imported, 2, '首次应全部导入')
  assert.equal(r1.skipped, 0)
  assert.equal(svc.execute('event.list', {}, {}).length, 2)

  const r2 = await importIcs(svc, TWO)
  assert.equal(r2.imported, 0, '第二次不得再建')
  assert.equal(r2.skipped, 2, '两条都应被跳过并上报')
  assert.equal(svc.execute('event.list', {}, {}).length, 2, '事件总数必须不变')

  // 第三次仍然稳定
  const r3 = await importIcs(svc, TWO)
  assert.equal(r3.imported, 0)
  assert.equal(r3.skipped, 2)
  assert.equal(svc.execute('event.list', {}, {}).length, 2)

  // UID 唯一性：不得出现重复 uid
  const rows = svc.execute('event.list', {}, {})
  const uids = rows.map((r) => r.uid).filter((u) => typeof u === 'string')
  assert.deepEqual([...uids].sort(), ['idem-001', 'idem-002'], '每条 uid 必须唯一')
}))

test('幂等：预览与执行使用同一套判重规则（不许两处漂移）', () => withService(async (svc) => {
  await importIcs(svc, TWO)

  const preview = svc.execute('event.previewIcs', { text: TWO, defaultTimeZone: TZ }, {})
  assert.equal(preview.counts.duplicate, 2, '预览必须说 2 条重复')

  const r = await importIcs(svc, TWO)
  assert.equal(r.skipped, preview.counts.duplicate,
    '预览说多少条重复，执行就必须跳过多少条 —— 这是两边共用判重函数的判据')
  assert.equal(r.imported, preview.counts.create,
    '预览说多少条新增，执行就必须建多少条')
}))

test('幂等：增量导入只建新的那几条', () => withService(async (svc) => {
  await importIcs(svc, makeIcs([
    { uid: 'inc-001', title: '已存在甲', start: '20261201T090000', end: '20261201T100000' },
  ]))

  const mixed = makeIcs([
    { uid: 'inc-001', title: '已存在甲', start: '20261201T090000', end: '20261201T100000' },
    { uid: 'inc-002', title: '新增乙', start: '20261203T090000', end: '20261203T100000' },
  ])
  const r = await importIcs(svc, mixed)
  assert.equal(r.imported, 1, '只建新的那条')
  assert.equal(r.skipped, 1, '已存在的跳过')
  assert.equal(svc.execute('event.list', {}, {}).length, 2)
}))

test('幂等：文件内部自重复也要跳过（同 UID 出现两次）', () => withService(async (svc) => {
  const dup = makeIcs([
    { uid: 'self-001', title: '文件内重复', start: '20261201T090000', end: '20261201T100000' },
    { uid: 'self-001', title: '文件内重复', start: '20261201T090000', end: '20261201T100000' },
  ])
  const r = await importIcs(svc, dup)
  assert.equal(r.imported, 1, '文件内同 UID 只建一条')
  assert.equal(r.skipped, 1)
  assert.equal(svc.execute('event.list', {}, {}).length, 1)

  const devPreview = svc.execute('event.previewIcs', { text: dup, defaultTimeZone: TZ }, {})
  // 全已存在 → 两条都是 duplicate
  assert.equal(devPreview.counts.duplicate, 2)
}))

test('幂等：软删后重新导入必须建回来（软删不参与判重）', () => withService(async (svc) => {
  await importIcs(svc, makeIcs([
    { uid: 'revive-001', title: '会被删的', start: '20261201T090000', end: '20261201T100000' },
  ]))
  assert.equal(svc.execute('event.list', {}, {}).length, 1)

  const [row] = svc.execute('event.list', {}, {})
  const delToken = await svc.requestApproval('event.delete', { target: row.id })
  svc.execute('event.delete', { id: row.id }, { actor: 'ui', approvalToken: delToken.token })
  assert.equal(svc.execute('event.list', {}, {}).length, 0, '软删后活跃列表为空')

  // 再导入同一份 → 必须建回来，而不是被判成「已存在」
  const r = await importIcs(svc, makeIcs([
    { uid: 'revive-001', title: '会被删的', start: '20261201T090000', end: '20261201T100000' },
  ]))
  assert.equal(r.imported, 1, '软删的事件不该挡住重新导入')
  assert.equal(r.skipped, 0)
  assert.equal(svc.execute('event.list', {}, {}).length, 1)
}))

test('幂等：判重只认 UID，同标题不同 UID 是两条', () => withService(async (svc) => {
  await importIcs(svc, makeIcs([
    { uid: 'same-title-a', title: '同名事件', start: '20261201T090000', end: '20261201T100000' },
  ]))
  const r = await importIcs(svc, makeIcs([
    { uid: 'same-title-b', title: '同名事件', start: '20261202T090000', end: '20261202T100000' },
  ]))
  assert.equal(r.imported, 1, '不同 UID 必须各建一条')
  assert.equal(r.skipped, 0)
  assert.equal(svc.execute('event.list', {}, {}).length, 2)
}))

test('幂等：跳过清单带足够定位信息（uid/title/时间）', () => withService(async (svc) => {
  await importIcs(svc, TWO)
  const r = await importIcs(svc, TWO)
  assert.equal(r.skippedEvents.length, 2)
  const first = r.skippedEvents.find((e) => e.uid === 'idem-001')
  assert.ok(first !== undefined, '跳过项要能被 uid 定位')
  assert.equal(first.title, '幂等甲')
  assert.equal(first.allDay, false)
}))

test('幂等：审批红线不受影响（无 token 仍拒）', () => withService(async (svc) => {
  await importIcs(svc, TWO)
  // 第二次不给 token
  assert.throws(
    () => svc.execute('event.import', { text: TWO, defaultTimeZone: TZ }, { actor: 'ui' }),
    (e) => e.code === 'confirmation-required',
    '幂等不等于免审批',
  )
  // payload 里自填 confirmed 也不被采信
  assert.throws(
    () => svc.execute('event.import', { text: TWO, confirmed: true, defaultTimeZone: TZ }, { actor: 'ui' }),
    (e) => e.code === 'confirmation-required',
  )
  assert.equal(svc.execute('event.list', {}, {}).length, 2, '被拒的导入不得改数据')
}))

test('幂等：全部跳过时仍然留备份并返回结构完整', () => withService(async (svc) => {
  await importIcs(svc, TWO)
  const r = await importIcs(svc, TWO)
  assert.equal(r.imported, 0)
  assert.equal(r.skipped, 2)
  assert.equal(typeof r.backup.path, 'string', '即使一条没建，也要能回滚')
  assert.ok(Array.isArray(r.warnings))
  assert.ok(Array.isArray(r.events))
  assert.equal(r.events.length, 0)
}))

test('幂等：不影响无 UID 的普通事件判重（用 id 兜底）', () => withService(async (svc) => {
  // 本地建两条事件（无 uid），再导入同 UID 的 ICS，不应把它们当重复
  svc.execute('event.create', {
    title: '本地的', allDay: false, start: '2026-12-01T09:00:00', timeZone: TZ,
  }, {})
  const r = await importIcs(svc, makeIcs([
    { uid: 'native-001', title: '导入的', start: '20261201T090000', end: '20261201T100000' },
  ]))
  assert.equal(r.imported, 1, '本地事件的 id 不会与 ICS 的 uid 相撞')
  assert.equal(svc.execute('event.list', {}, {}).length, 2)
}))

// ------------------------------------------------ 无 UID 的 ICS 幂等

test('幂等：不带 UID 的 ICS 重复导入也不得重复创建（内容指纹兜底）', () => withService(async (svc) => {
  /**
   * 这是自查发现的**遗留漏洞**：
   * `parseIcs` 对无 UID 条目不设 `uid`，创建时 `event-repo` 用新生成的随机
   * `id` 兜底（`uid ?? id`），于是每次导入 uid 都不同、判重永远命中不了。
   * 实测修复前：两次导入 imported 都是 1，总数变成 2。
   */
  const ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:无UID事件\n'
    + 'DTSTART;TZID=' + TZ + ':20261201T090000\n'
    + 'DTEND;TZID=' + TZ + ':20261201T100000\n'
    + 'END:VEVENT\nEND:VCALENDAR\n'

  const r1 = await importIcs(svc, ics)
  assert.equal(r1.imported, 1)
  assert.equal(r1.skipped, 0)

  const r2 = await importIcs(svc, ics)
  assert.equal(r2.imported, 0, '无 UID 的同一份文件重复导入不得再建')
  assert.equal(r2.skipped, 1)

  const r3 = await importIcs(svc, ics)
  assert.equal(r3.imported, 0)
  assert.equal(svc.execute('event.list', {}, {}).length, 1, '事件总数必须稳定为 1')

  // 落盘身份必须是稳定的内容指纹，不是随机 id
  const [row] = svc.execute('event.list', {}, {})
  assert.match(row.uid, /^sha:[0-9a-f]{24}$/, '无 UID 条目应写入内容指纹')
}))

test('幂等：无 UID 但内容不同（标题/时间变化）仍是两条', () => withService(async (svc) => {
  const mk = (title, start) => 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n'
    + `SUMMARY:${title}\nDTSTART;TZID=${TZ}:${start}\n`
    + `DTEND;TZID=${TZ}:${start.replace('T09', 'T10')}\n`
    + 'END:VEVENT\nEND:VCALENDAR\n'

  await importIcs(svc, mk('甲', '20261201T090000'))
  const r = await importIcs(svc, mk('乙', '20261201T090000'))
  assert.equal(r.imported, 1, '标题不同 → 指纹不同 → 应各建一条')
  assert.equal(svc.execute('event.list', {}, {}).length, 2)

  const r2 = await importIcs(svc, mk('甲', '20261203T090000'))
  assert.equal(r2.imported, 1, '时间不同 → 指纹不同')
  assert.equal(svc.execute('event.list', {}, {}).length, 3)
}))

test('幂等：有 UID 时一律以 UID 为准，不被内容指纹覆盖', () => withService(async (svc) => {
  // 同标题同时间但 UID 不同 → 必须是两条（UID 优先）
  await importIcs(svc, makeIcs([
    { uid: 'keep-uid-a', title: '同名', start: '20261201T090000', end: '20261201T100000' },
  ]))
  const r = await importIcs(svc, makeIcs([
    { uid: 'keep-uid-b', title: '同名', start: '20261201T090000', end: '20261201T100000' },
  ]))
  assert.equal(r.imported, 1, '有 UID 时不得退化成内容指纹')
  const rows = svc.execute('event.list', {}, {})
  assert.equal(rows.length, 2)
  const uids = rows.map((x) => x.uid).sort()
  assert.deepEqual(uids, ['keep-uid-a', 'keep-uid-b'], '落盘uid必须是原始UID')
}))

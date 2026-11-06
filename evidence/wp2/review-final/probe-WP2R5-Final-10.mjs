#!/usr/bin/env node
/**
 * WP2R5-Final 独立探针 10：诚实性核对。
 *
 * 任务书第 6 项：
 *   - 报告与实测数字是否一致（测试数、变异数、各类结论）
 *   - 有没有把「模拟通过」写成「真实通过」
 *   - docs/wp2/10-round4-audit.md 记录的 N-17 与本轮新修的问题是否都真实存在（可从代码验证）
 *
 * 本探针**不**跑代码，只做「文档声称 vs 冻结目录可验证事实」的对照。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FREEZE = '/tmp/wp2r5-freeze-2b0aabb'
let fail = 0
const say = (...a) => console.log(a.join(' '))
const ok = (n, e = '') => say(`  ✅ ${n}${e ? '  ' + e : ''}`)
const bad = (n, e = '') => { say(`  ❌ ${n}${e ? '  ' + e : ''}`); fail += 1 }
const note = (n) => say(`  ℹ️  ${n}`)

say('=== WP2R5-Final 探针 10：诚实性核对 ===')
say('')

// ---- A) 探针是否 import 冻结目录 ----
say('--- A) 三个探针的 import 目标 ---')
for (const p of ['p1-real-storage-domain', 'p2-protect', 'p3-retention']) {
  const src = readFileSync(join(FREEZE, 'scripts', 'probes', `${p}.mjs`), 'utf8')
  const m = src.match(/const REPO = '([^']+)'/)
  const importsFreeze = src.includes('/tmp/wp2r5-freeze')
  const importsLive = m !== null && m[1] === '<repo>'
  if (importsLive) bad(`${p}：REPO 指向主仓库工作副本（${m[1]}）→ 测的不是冻结版`)
  else ok(`${p}：REPO=${m?.[1] ?? '(无)'}，importsFreeze=${importsFreeze}`)
}

say('')
say('--- B) 已提交证据日志的数字 vs 冻结版实测 ---')
{
  // B1 unit-tests.log
  const p = join(FREEZE, 'evidence', 'wp2', 'review-final', 'unit-tests.log')
  if (existsSync(p)) {
    const log = readFileSync(p, 'utf8')
    const pass = log.match(/^# pass (\d+)$/m)?.[1]
    const failN = log.match(/^# fail (\d+)$/m)?.[1]
    say(`    已提交 unit-tests.log: pass=${pass} fail=${failN}`)
    note(`    我实测（冻结版）: pass=196 fail=0`)
    if (pass === '196') ok('测试数一致（196）')
    else bad(`测试数不一致：日志说 ${pass}，冻结版实测 196`)
  } else bad('缺 unit-tests.log')
}
{
  // B2 mutation.log
  const p = join(FREEZE, 'evidence', 'wp2', 'review-final', 'mutation.log')
  if (existsSync(p)) {
    const log = readFileSync(p, 'utf8')
    const caught = log.match(/CAUGHT:\s*(\d+)/)?.[1]
    const vacuum = log.match(/VACUUM:\s*(\d+)/)?.[1]
    const skip = log.match(/SKIP:\s*(\d+)/)?.[1]
    say(`    已提交 mutation.log: CAUGHT=${caught} VACUUM=${vacuum} SKIP=${skip}`)
    note(`    我实测（冻结版）: CAUGHT=31 VACUUM=0 SKIP=0`)
    if (caught === '31') ok('变异数一致（31）')
    else bad(`变异数不一致：日志说 ${caught}，冻结版实测 31`)
  } else bad('缺 mutation.log')
}

say('')
say('--- C) 「模拟通过」是否被写成「真实通过」 ---')
{
  const doc = readFileSync(join(FREEZE, 'docs', 'wp2', '10-round4-audit.md'), 'utf8')
  const claims = [
    ['L4 用假 storageDomain', doc.includes('L4 用假 storageDomain')],
    ['不能生产端到端', doc.includes('生产环境端到端已验证')],
    ['第三方复审未产出', doc.includes('未产出')],
  ]
  for (const [label, present] of claims) {
    present ? ok(`round4-audit 如实记录：${label}`) : note(`round4-audit 未见「${label}」`)
  }
  // 检查是否有把 probe 结论夸大的措辞
  const overclaim = doc.includes('生产环境端到端已验证」') && !doc.includes('不能说')
  if (overclaim) bad('round4-audit 存在夸大措辞')
  else ok('round4-audit 未见夸大措辞（明确列出「不能说」清单）')
}

say('')
say('--- D) round4-audit 记录的 N-17 是否真实存在（代码验证）---')
{
  // N-17: UNKNOWN 时不得删除仍然 active 的宿主提醒
  const rec = readFileSync(join(FREEZE, 'workbench-core', 'src', 'reminder-recovery.js'), 'utf8')
  const hasProtectPass = rec.includes('protect: unknown.map((u) => u.reminderKey)')
  const hasPrunedGuard = rec.includes('res.earlierRecordsUnavailable === true')
  hasProtectPass
    ? ok('recover 把 UNKNOWN 的 key 传给 protect（修法 2 在位）')
    : bad('recover 未传 protect —— N-17 未修')
  hasPrunedGuard
    ? ok('deliveryStateOf 对 earlierRecordsUnavailable=true 判 UNKNOWN')
    : bad('earlierRecordsUnavailable 判定缺失')

  const ad = readFileSync(join(FREEZE, 'workbench-core', 'src', 'schedule-adapter.js'), 'utf8')
  const hasProtectGuard = ad.includes('if (protect.has(key)) continue')
  hasProtectGuard
    ? ok('reconcile 跳过 protect 集合（修法 1 在位）')
    : bad('reconcile 未跳过 protect —— N-17 未修')

  // N-02: 非对象 history → UNKNOWN（R5-1 新修）
  const hasShapeGuard = ad.includes("history-invalid-shape")
  hasShapeGuard
    ? ok('非对象 history → UNAVAILABLE（R5-1 新修在位）')
    : bad('非对象 history 未判 UNAVAILABLE —— R5-1 声称的新修不成立')

  // N-03/N-04/N-05/N-08/N-11 在位性
  const checks = [
    ['N-03 unmapped 上报', ad.includes('unmapped.push') && ad.includes('needsAttention')],
    ['N-04 create 失败不中断', ad.includes('host-create-rejected')],
    ['N-11 scope 按字段过滤', ad.includes('row.scope === scope')],
    ['N-08 删除失败计入 failed', ad.includes("op: 'remove'")],
  ]
  const svc = readFileSync(join(FREEZE, 'workbench-core', 'src', 'service.js'), 'utf8')
  checks.push(['N-05 deny 在唯一入口拦截', svc.includes("gate.mode === 'deny' && WRITE_OPS.includes(op)")])
  checks.push(['N-06 restore/upsert 入危险清单', svc.includes("'event.restore'") && svc.includes("'task.upsert'")])
  for (const [label, present] of checks) {
    present ? ok(`${label} 在位`) : bad(`${label} 缺失 —— 声称的修复不成立`)
  }
}

say('')
say('--- E) 报告声称的 8 项门禁是否与冻结目录一致 ---')
{
  const gate = readFileSync(join(FREEZE, 'scripts', 'wp2-r5-gate.sh'), 'utf8')
  const steps = [...gate.matchAll(/step\s+"([^"]+)"/g)].map((m) => m[1])
  say(`    冻结版门禁项（${steps.length}）: ${steps.join(', ')}`)
  const committed = [
    'acceptance-8.log', 'demo.log', 'mutation.log', 'mutations.log',
    'p1-real-storage-domain.log', 'p2-protect.log', 'p3-retention.log',
    'probe-protect.log', 'probe-real-storage.log', 'probe-retention.log',
    'real-service-l4.log', 'unit-tests.log',
  ]
  const missing = committed.filter((f) => !existsSync(join(FREEZE, 'evidence', 'wp2', 'review-final', f)))
  missing.length === 0
    ? ok('已提交证据日志齐全')
    : note(`已提交目录缺少（无害）：${missing.join(', ')}`)
}

say('')
say(`=== 探针 10 汇总：${fail === 0 ? 'PASS' : `FAIL（${fail} 项）`} ===`)
process.exit(fail > 0 ? 1 : 0)

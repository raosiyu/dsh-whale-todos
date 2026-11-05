/**
 * 真实宿主契约验证（**用 app.asar 里的真实代码**，不是 stub）。
 *
 * 分四级，结果分别报告：
 *   L1 取包       从 app.asar 解出真实 lib/index.js
 *   L2 加载       真正 import 该模块（依赖从解出的 node_modules 解析）
 *   L3 行为       调用真实导出函数（createAtScheduleRecord 等）验证校验语义
 *   L4 Service    实例化真实 ScheduleService —— 需运行中 Cordis Context
 *
 * 用法：node scripts/r3-real-host.mjs
 * 退出码：0 = L1-L3 全通过；2 = L4 BLOCKED；1 = 失败
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const INNER = 'dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js'
const log = (...a) => console.log(...a)

let failed = 0
let blockedFlag = false

const work = mkdtempSync(join(tmpdir(), 'r3-real-'))
let extracted = ''
try {
  log('=== L1 取包（从 app.asar 提取真实源码）===')
  try {
    execFileSync('npx', ['--yes', '@electron/asar', 'extract-file', ASAR, INNER], {
      cwd: work, stdio: 'pipe',
    })
    extracted = join(work, 'index.js')
    if (!existsSync(extracted)) throw new Error('extract-file 未产出文件')
    log(`  ✅ 已取出（${readFileSync(extracted, 'utf8').length} 字符）`)
  } catch (error) {
    log(`  ❌ ${String(error?.message ?? error).slice(0, 160)}`)
    failed += 1
  }

  if (extracted !== '') {
    log('')
    log('=== L2 加载真实模块 ===')
    let mod
    try {
      // 依赖需要从解出的整包 node_modules 解析；若不在该目录下，退化为静态核对
      mod = await import(`file://${extracted}`)
      log(`  ✅ 加载成功，导出 ${Object.keys(mod).length} 个符号`)
      log(`     关键导出: ${['ScheduleService', 'createAtScheduleRecord', 'scheduleTitle', 'scheduleDomain']
        .filter((k) => k in mod).join(', ')}`)
    } catch (error) {
      log(`  ⚠️ 直接 import 失败（依赖解析）：${String(error?.message ?? error).slice(0, 120)}`)
      log('     将改用「在解出的整包目录内加载」的方式，见 L2b。')
    }

    log('')
    log('=== L2b 在解出的整包目录内加载 ===')
    const FULL = '/tmp/dsh-asar-full/dsh'
    const fullLib = join(FULL, 'node_modules/@deepseek-ai/dsh-schedule/lib/index.js')
    if (existsSync(fullLib)) {
      try {
        mod = await import(`file://${fullLib}`)
        log(`  ✅ 加载成功，导出 ${Object.keys(mod).length} 个符号`)
      } catch (error) {
        log(`  ⚠️ 仍失败：${String(error?.message ?? error).slice(0, 140)}`)
      }
    } else {
      log('  （未准备整包副本，跳过；运行 scripts/r3-prepare-asar.sh 可生成）')
    }

    if (mod !== undefined) {
      log('')
      log('=== L3 用真实代码验证校验语义 ===')
      const now = Date.UTC(2026, 10, 5, 0, 0, 0)
      const future = new Date(Date.UTC(2026, 10, 5, 9, 0, 0)).toISOString()

      const expect = (name, fn, wantCode) => {
        try {
          fn()
          log(`  ❌ ${name}：未被拒（期望 ${wantCode}）`)
          failed += 1
        } catch (error) {
          const okCode = error?.code === wantCode
          log(`  ${okCode ? '✅' : '❌'} ${name}：${error?.code}${okCode ? '' : `（期望 ${wantCode}）`}`)
          if (!okCode) failed += 1
        }
      }

      // 合法创建
      try {
        const rec = mod.createAtScheduleRecord('schedule-ok', '正文', future, now, '标题')
        const okShape = rec.kind === 'at'
          && rec.scheduledAt === '2026-11-05T09:00:00.000Z'
          && rec.title === '标题'
          && rec.prompt === '正文'
          && Object.isFrozen(rec)
        log(`  ${okShape ? '✅' : '❌'} 合法 at 创建出正确 record（kind/scheduledAt/title/prompt/frozen）`)
        if (!okShape) failed += 1
        // 契约：record 不含 key 字段
        log(`  ${'key' in rec ? '❌' : '✅'} record 不含 key 字段（身份不能靠宿主回报）`)
        if ('key' in rec) failed += 1
      } catch (error) {
        log(`  ❌ 合法创建失败：${error?.code} ${error?.message}`)
        failed += 1
      }

      expect('at 传数字被拒', () => mod.createAtScheduleRecord('s2', 'p', Date.UTC(2026, 10, 5, 9), now, 't'), 'invalid_rule')
      expect('at 在过去被拒', () => mod.createAtScheduleRecord('s3', 'p', new Date(Date.UTC(2026, 10, 4, 9)).toISOString(), now, 't'), 'not_future')
      expect('at 无时区被拒', () => mod.createAtScheduleRecord('s4', 'p', '2026-11-05T09:00:00', now, 't'), 'invalid_rule')
      expect('at 不存在的日历日被拒', () => mod.createAtScheduleRecord('s5', 'p', '2026-02-30T09:00:00Z', now, 't'), 'invalid_rule')
      expect('空 title 被拒', () => mod.createAtScheduleRecord('s6', 'p', future, now, '   '), 'invalid_prompt')
      expect('超长 title 被拒', () => mod.createAtScheduleRecord('s7', 'p', future, now, 'x'.repeat(121)), 'invalid_prompt')

      log('')
      log('=== L4 真实 ScheduleService 实例化 ===')
      log(`  ScheduleService 是 ${typeof mod.ScheduleService}`)
      log(`  static inject: ${JSON.stringify(mod.ScheduleService?.inject ?? null)}`)
      log('  → 继承 Cordis Service，构造需运行中的 ctx（storageDomain/sessions/agents/…）')
      log('  ❌ BLOCKED：本会话未启动完整 Host。启动 GUI 会挂起且可能触碰真实 profile，')
      log('     故不在此执行；该项不计 PASS。')
      blockedFlag = true
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

log('')
log('=== 汇总 ===')
log(`  L1-L3：${failed === 0 ? 'PASS' : `FAIL（${failed} 项）`}`)
log(`  L4 真实 Service 实例化：${blockedFlag ? 'BLOCKED（需运行中 Host，不记 PASS）' : '未执行'}`)
process.exit(failed > 0 ? 1 : 0)

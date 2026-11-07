/**
 * WP5.2-P0 · 隔离 DSH Host 真机验证探针
 *
 * 目的：在真实 Host（真 `ctx.schedule`）里验证
 *  - 含冒号/Unicode 的 scope 连续多次 reconcile 只创建 1 条 active 提醒
 *  - 进程重启后不重复创建
 *  - Host `schedule.json` 里该 scope 的 active 记录恒为 1
 *
 * 只读业务代码；数据写在隔离 DSH_HOME 内。
 * 运行方式：装到隔离 profile 的 @local 下，由 dsh 启动时执行。
 */
import { appendFileSync, writeFileSync } from 'node:fs'

const LOG = '/tmp/wp52p0-verify.log'
const OUT = '/tmp/wp52p0-verify.json'
const log = (m) => appendFileSync(LOG, `[p0] ${new Date().toISOString()} ${m}\n`)

export const name = 'wp52p0-verify'
export function apply(ctx) {
  log('apply, pid=' + process.pid)
  ctx.inject(['schedule', 'sessions'], (sub) => {
    log('services ready')
    const timer = setInterval(async () => {
      try {
        const store = sub.sessions?.store
        const ids = store && typeof store.keys === 'function' ? [...store.keys()] : []
        if (ids.length === 0) return
        clearInterval(timer)
        const sid = ids[0]
        log('session=' + sid)

        const { createReminderSync } = await import(
          '/Users/sylas/Developer/dsh-workbench/workbench-core/src/reminder-sync.js'
        )
        const sync = createReminderSync({ schedule: sub.schedule })

        const SCOPES = ['a::b', 'proj:sub', 'x:y:z', '中文:作用域', '']
        const results = []
        const NOWMS = Date.now()
        const FUTURE = new Date(NOWMS + 30 * 24 * 3600 * 1000).toISOString()

        for (const scope of SCOPES) {
          const data = {
            tasks: [{ id: 'vt1', title: '真机验证-' + (scope || 'empty'), dueAt: FUTURE, done: false, status: 'planned' }],
          }
          // 连续 3 次 reconcile
          const rounds = []
          for (let i = 0; i < 3; i += 1) {
            const r = await sync.reconcile(sid, data, scope)
            rounds.push({ created: r.created, updated: r.updated, unchanged: r.unchanged, deleted: r.deleted, failed: r.failed.length })
          }
          // 统计 Host 上属于该 scope 的 active 记录
          const cat = await sub.schedule.catalog()
          const mine = cat.filter((row) => row.sessionId === sid && (row.prompt || '').includes('真机验证-' + (scope || 'empty')))
          results.push({ scope, rounds, hostActive: mine.length, ids: mine.map((m) => m.id) })
          log(`scope=${JSON.stringify(scope)} rounds=${JSON.stringify(rounds.map(r => r.created))} hostActive=${mine.length}`)
        }

        // 汇总判定
        const allOk = results.every((r) => r.rounds[0].created === 1
          && r.rounds[1].created === 0 && r.rounds[2].created === 0
          && r.hostActive === 1)
        writeFileSync(OUT, JSON.stringify({ pid: process.pid, sessionId: sid, results, allOk }, null, 2))
        log('VERDICT allOk=' + allOk)
      } catch (e) {
        log('ERR: ' + (e?.code || e?.message || e))
      }
    }, 3000)
  })
}

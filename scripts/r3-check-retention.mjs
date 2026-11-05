import { createScheduleAdapter, openHostMap } from '../workbench-core/src/index.js'
import { createContractStub } from '../workbench-core/test/helpers/contract-stub.mjs'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = Date.UTC(2026,10,5,0,0,0), HOUR = 3600000, MIN = 60000
const dir = mkdtempSync(join(tmpdir(),'leak2-'))
const mapPath = join(dir,'hostmap.json')
const stub = createContractStub({ now: () => BASE })
const hostMap = openHostMap({ filePath: mapPath })
const adapter = createScheduleAdapter({ backend:'host', hostSchedule: stub, hostMap, sessionId:'s1', now: () => BASE })

// 一次性建 30 条（同一个 desired 集合）
const plans = Array.from({length:30},(_,i)=>({
  reminderKey:`k-${i}`, fireAtMs: BASE+HOUR+i*MIN, title:`T${i}`, prompt:'p', kind:'event-start',
}))
const r = await adapter.reconcile(plans)
console.log(`建 30 条: created=${r.created.length} 宿主=${(await stub.catalog()).length} hostMap=${hostMap.size}`)

// 全部投递
stub.tick(BASE+HOUR+29*MIN)
console.log(`全部投递后: 宿主 catalog=${(await stub.catalog()).length}（含 inactive） hostMap=${hostMap.size}`)

// 用户删掉所有事件 → desired 为空
const r2 = await adapter.reconcile([])
console.log(`空对账后: removed=${r2.removed.length} 宿主=${(await stub.catalog()).length} hostMap=${hostMap.size}`)
console.log('')
console.log(`判定: ${hostMap.size > 0 || (await stub.catalog()).length > 0
  ? `⚠️ 已投递提醒永久保留：宿主 ${(await stub.catalog()).length} 条 inactive、hostMap ${hostMap.size} 条映射，无清理策略`
  : '✅ 已清理'}`)
const size = statSync(mapPath).size
console.log(`hostmap.json 大小: ${size} 字节`)
rmSync(dir,{recursive:true,force:true})

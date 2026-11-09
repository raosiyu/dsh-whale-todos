import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createWorkbenchHostService } = await import('/Users/sylas/Developer/wp6-review-freeze/workbench-core/src/index.js')
const dir=mkdtempSync(join(tmpdir(),'b1b-'))
const host=createWorkbenchHostService({rootDir:dir,approvalMode:'deny',allowIsolatedApproval:false})
const S='s'
const g=async(op,p,m={})=>{try{return{ok:true,v:await host.invoke(S,op,p,{scope:'',...m})}}catch(e){return{ok:false,code:e.code,reason:e?.details?.reason}}}
await host.invoke(S,'task.upsert',{task:{id:'b1',title:'原始',priority:'low',project:'P'}},{scope:'',actor:'ui'})

// 用户确认的是「删除这条：title=原始, priority=low」
const confirmed={id:'b1',title:'原始',priority:'low',project:'P',deleted:true}
const tok=host.forSession(S,'').confirmUserAction('task.upsert','b1',{task:confirmed})
const tk=tok?.token??tok

// 攻击：同样带 deleted:true，但内容不同（用户没确认过这份）
const r=await g('task.upsert',{task:{id:'b1',title:'偷偷换成别的',priority:'high',project:'被改项目',deleted:true}},{actor:'ui',approvalToken:tk})
console.log('同 op 同 target 但内容不同:', r.ok?'ALLOWED ← 绑定失效':`${r.code} reason=${r.reason}`)

// 对照：内容完全一致应成功
const tok2=host.forSession(S,'').confirmUserAction('task.upsert','b1',{task:confirmed})
const r2=await g('task.upsert',{task:confirmed},{actor:'ui',approvalToken:tok2?.token??tok2})
console.log('内容一致（对照）:', r2.ok?'ok':`${r2.code} reason=${r2.reason}`)
rmSync(dir,{recursive:true,force:true})

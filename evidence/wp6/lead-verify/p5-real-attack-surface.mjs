/**
 * 真实攻击面探针：数据按 sessionId 分片，所以跨会话覆盖本就不可能。
 * 真实威胁是「同一会话内 actor 越权」与「共享 collab 提案层」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createWorkbenchHostService } = await import('/Users/sylas/Developer/wp6-review-freeze/workbench-core/src/index.js')

let pass=0, fail=0
const R=[]
const ok=(n,c,d='')=>{ if(c){pass++;R.push(`  PASS  ${n}${d?' — '+d:''}`)}else{fail++;R.push(`  FAIL  ${n}${d?' — '+d:''}`)} }
const arr=(v)=>(Array.isArray(v)?v:(v?.tasks??[]))
const mk=(o={})=>{ const dir=mkdtempSync(join(tmpdir(),'real-')); return { dir, host:createWorkbenchHostService({rootDir:dir,approvalMode:'deny',allowIsolatedApproval:false,...o}), done:()=>rmSync(dir,{recursive:true,force:true}) } }
const call=async(host,sid,op,p,m={})=>{ try{ return {ok:true,v:await host.invoke(sid,op,p,{scope:'',...m})} }catch(e){ return {ok:false,code:e?.code,message:e?.message} } }

// 同一会话内：Agent actor 覆盖用户建的待办
{
  const t=mk(); const S='sess-shared'
  await call(t.host,S,'task.upsert',{task:{id:'r1',title:'原始',priority:'low',project:'P'}},{actor:'ui'})
  for(const a of ['agent-tool','agent','agent_tool','ai']){
    const r=await call(t.host,S,'task.upsert',{task:{id:'r1',title:'被改',priority:'high',project:'P'}},{actor:a})
    ok(`同会话 ${a} 覆盖既有待办被拒`, !r.ok && r.code==='confirmation-required', r.code??'ALLOWED!')
  }
  const row=arr((await call(t.host,S,'task.list',{},{actor:'ui'})).v).find(x=>x.id==='r1')
  ok('同会话覆盖被拒后数据未变', row?.title==='原始', `title=${row?.title}`)

  // 用户本人同会话编辑必须放行
  const ue=await call(t.host,S,'task.upsert',{task:{id:'r1',title:'用户自己改',priority:'low',project:'P'}},{actor:'ui'})
  ok('同会话用户本人编辑放行', ue.ok, ue.code??'ok')

  // Agent 拿「删除 r1」的凭证去改写 r1 内容
  const del={task:{id:'r1',title:'用户自己改',priority:'low',project:'P',deleted:true}}
  const tok=t.host.forSession(S,'').confirmUserAction('task.upsert','r1',{task:del.task})
  const bt=tok?.token??tok
  const hij=await call(t.host,S,'task.upsert',{task:{id:'r1',title:'凭证劫持改写',priority:'high',project:'P'}},{actor:'agent-tool',approvalToken:bt})
  ok('删除凭证不得用于改写内容（Agent）', !hij.ok, hij.code??'ALLOWED!')
  const row2=arr((await call(t.host,S,'task.list',{},{actor:'ui'})).v).find(x=>x.id==='r1')
  ok('凭证劫持失败后数据未变', row2?.title==='用户自己改', `title=${row2?.title}`)

  // 凭证本身有效：用户身份用同一凭证执行其本意操作（删除）应当成功。
  // 注意不能用 agent-tool 验这条 —— Agent 直写既有行被 F1b 硬拦（按用户裁定
  // 改走提案），那是另一条守卫，与凭证有效性无关，混在一起会误判成凭证缺陷。
  const t2=t.host.forSession(S,'').confirmUserAction('task.upsert','r1',{task:del.task})
  const legit=await call(t.host,S,'task.upsert',del,{actor:'ui',approvalToken:t2?.token??t2})
  ok('凭证用于其本意操作（用户删除）仍成功', legit.ok, legit.code??'ok')

  // Agent 即使持合法凭证也不得直写既有行（用户裁定：走提案）
  const t3=t.host.forSession(S,'').confirmUserAction('task.upsert','r1',{task:del.task})
  const agentDel=await call(t.host,S,'task.upsert',del,{actor:'agent-tool',approvalToken:t3?.token??t3})
  ok('Agent 持凭证仍不得直写既有行（走提案）', !agentDel.ok, agentDel.code??'ALLOWED!')
  t.done()
}

console.log(R.join('\n'))
console.log(`\n真实攻击面汇总: PASS=${pass} FAIL=${fail}`)
process.exit(fail===0?0:1)

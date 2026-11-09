import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createWorkbenchHostService } = await import('/Users/sylas/Developer/wp6-review-freeze/workbench-core/src/index.js')

const dir = mkdtempSync(join(tmpdir(), 'v9-'))
const host = createWorkbenchHostService({ rootDir: dir, approvalMode: 'deny', allowIsolatedApproval: false })
const S = 's'

await host.invoke(S, 'task.upsert', { task: { id: 'b1', title: '原始', priority: 'low', project: 'P' } }, { scope: '', actor: 'ui' })

const confirmed = { id: 'b1', title: '原始', priority: 'low', project: 'P', deleted: true }

const confirmed1 = host.forSession(S, '').confirmUserAction('task.upsert', 'b1', { task: confirmed })
const tk = confirmed1?.token ?? confirmed1

const g = async (p, token) => {
  try {
    return { ok: true, v: await host.invoke(S, 'task.upsert', p, { scope: '', actor: 'ui', approvalToken: token }) }
  } catch (e) {
    return { ok: false, code: e.code, msg: e.message }
  }
}

// 篡改内容：同一 token，title 换成别的，priority 也改
const tampered = await g({ task: { id: 'b1', title: '换成别的', priority: 'high', project: 'P', deleted: true } }, tk)
console.log('篡改:', JSON.stringify(tampered))

// 对照：内容一致，需重新签发（token 一次性）
const confirmed2 = host.forSession(S, '').confirmUserAction('task.upsert', 'b1', { task: confirmed })
const tk2 = confirmed2?.token ?? confirmed2
const control = await g({ task: confirmed }, tk2)
console.log('对照:', JSON.stringify(control))

// 额外：确认 b1 是否还在（篡改若成功会被删掉）
try {
  const list = await host.invoke(S, 'task.list', {}, { scope: '', actor: 'ui' })
  console.log('列表:', JSON.stringify(list))
} catch (e) {
  console.log('列表异常:', e.code, e.message)
}

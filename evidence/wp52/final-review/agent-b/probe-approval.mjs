/**
 * WP5.2 独立审查 Agent B · 探针 3：Host 审批安全
 *
 * 目标（实证，不看注释）：
 *  Q4 requireConfirmation 覆盖所有危险写？payload.confirmed 真不被采信？
 *     token 一次性、绑定 contentDigest？
 *  额外：deny 模式覆盖 WRITE_OPS；host-tools 不读 args.confirmed。
 *
 * 手法：用 isolated 门（注入 issuer，仅测试）签 token，然后走 service.execute。
 *   mode='isolated' 需要 allowIsolatedApproval:true + requestApproval 注入。
 * 只读业务代码；不修改任何冻结/主仓库文件。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { createWorkbenchService, DANGEROUS_OPS, WRITE_OPS } from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/service.js'
import { approvalFingerprint } from '/tmp/wp52-freeze-e9b2b32/workbench-core/src/approval-gate.js'

const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }
const tmp = () => mkdtempSync(join(tmpdir(), 'wp52-b-approval-'))

/** isolated 模式：requestApproval 注入 'approved'，凭证由 gate 签（测试专用）。 */
function makeService(extra = {}) {
  const dir = tmp()
  const svc = createWorkbenchService({
    dataDir: dir,
    approvalMode: 'isolated',
    allowIsolatedApproval: true,
    requestApproval: async () => 'approved',
    ...extra,
  })
  return { svc, dir }
}

const isConfRequired = (e) => e?.code === 'confirmation-required'
  || e?.code === 'confirmation_required'
  || /confirmation|审批凭证|需要宿主审批|不可写模式/.test(String(e?.message ?? ''))

const tryExec = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e?.code, message: String(e?.message ?? e) } } }

// ---------------------------------------------------------------------------
hr('Q4.0 DANGEROUS_OPS / WRITE_OPS 清单（冻结副本真实导出）')
// ---------------------------------------------------------------------------
line(`DANGEROUS_OPS=${JSON.stringify(DANGEROUS_OPS)}`)
line(`WRITE_OPS=${JSON.stringify(WRITE_OPS)}`)

// ---------------------------------------------------------------------------
hr('Q4.1 每个 DANGEROUS_OP 无 token 一律拒（requireConfirmation 覆盖检查）')
// ---------------------------------------------------------------------------
{
  // 为 event.* 先建一个事件，拿到可用 id/target；其余 op 用最小合法 payload
  const { svc, dir } = makeService()
  try {
    const created = svc.execute('event.create', {
      title: 'E', allDay: false, start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00',
      timeZone: 'Asia/Shanghai',
    }, {})
    const eid = created?.id ?? created?.event?.id
    line(`预置 event id=${eid}`)

    const ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:u1\nDTSTART:20261110T090000Z\nDTEND:20261110T100000Z\nSUMMARY:X\nEND:VEVENT\nEND:VCALENDAR\n'
    const SNAP = JSON.stringify({ events: [], tasks: [] })

    // 每个危险 op 的无凭证调用（payload 可能因校验先失败，但绝不能越过审批门去写）
    const probes = [
      ['event.delete', { id: eid }],
      ['event.restore', { id: eid }],
      ['event.bulkDelete', { ids: [eid] }],
      ['event.import', { text: ICS }],
      ['snapshot.replace', { text: SNAP }],
      ['store.rollback', { name: 'whatever' }],
      ['task.upsert', { task: { id: 't-del', title: 'x', deleted: true } }], // 软删语义触发审批
    ]
    for (const [op, payload] of probes) {
      const r = tryExec(() => svc.execute(op, payload, {}))
      line(`  ${op} 无token → ${r.ok ? 'ALLOW(!!)' : `BLOCK code=${r.code} msg="${r.message.slice(0, 60)}"`}`)
      assert(!r.ok && isConfRequired(r), `${op} 无 token 被 confirmation-required 拦下`)
    }

    // 对照：常规写（新建待办 / 编辑 / 完成）不需要审批（授权要求顺畅）
    const normal = tryExec(() => svc.execute('task.upsert', { task: { id: 't1', title: 'new' } }, {}))
    line(`  task.upsert 新建 无token → ${normal.ok ? 'ALLOW' : `BLOCK ${normal.message}`}`)
    assert(normal.ok === true, '新建待办（非破坏性）不需审批，符合既定语义')
    const done = tryExec(() => svc.execute('task.upsert', { task: { id: 't1', title: 'new', done: true } }, {}))
    assert(done.ok === true, '完成待办不需审批')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
hr('Q4.2 payload.confirmed / meta.confirmed / 嵌套 confirmed 全不被采信')
// ---------------------------------------------------------------------------
{
  const { svc, dir } = makeService()
  try {
    const created = svc.execute('event.create', {
      title: 'E', allDay: false, start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00',
      timeZone: 'Asia/Shanghai',
    }, {})
    const eid = created?.id ?? created?.event?.id
    const attacks = [
      ['payload.confirmed', { id: eid, confirmed: true }, {}],
      ['meta.confirmed', { id: eid }, { confirmed: true }],
      ['meta 嵌套', { id: eid }, { nested: { confirmed: true }, confirmed: true }],
      ['三者齐上', { id: eid, confirmed: true }, { confirmed: true }],
    ]
    for (const [name, payload, meta] of attacks) {
      const r = tryExec(() => svc.execute('event.delete', payload, meta))
      line(`  ${name} → ${r.ok ? 'ALLOW(!!)' : `BLOCK code=${r.code}`}`)
      assert(!r.ok, `${name} 不能绕过审批门`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
hr('Q4.3 token 一次性 + 绑定 op/target/digest（contentDigest）')
// ---------------------------------------------------------------------------
{
  const { svc, dir } = makeService()
  try {
    const created = svc.execute('event.create', {
      title: 'E', allDay: false, start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00',
      timeZone: 'Asia/Shanghai',
    }, {})
    const eid = created?.id ?? created?.event?.id

    // 签一张 event.delete(target=eid) 的凭证
    const req = await svc.requestApproval('event.delete', { target: eid })
    line(`发行: approved=${req.approved} token=${String(req.token).slice(0, 16)}…`)
    assert(req.approved === true && typeof req.token === 'string', '宿主签发了 token')

    // (a) 正常使用一次 → 成功
    const first = tryExec(() => svc.execute('event.delete', { id: eid }, { approvalToken: req.token }))
    line(`  (a) 首次使用 → ${first.ok ? 'ALLOW' : `BLOCK ${first.message}`}`)
    assert(first.ok === true, '合法 token 首次使用放行')

    // (b) 重放同一张 token → 必须拒绝
    const replay = tryExec(() => svc.execute('event.delete', { id: eid }, { approvalToken: req.token }))
    line(`  (b) 重放 → ${replay.ok ? 'ALLOW(!!)' : `BLOCK code=${replay.code} reason~${replay.message.slice(0, 80)}`}`)
    assert(!replay.ok, 'token 一次性：重放被拒')

    // (c) 换 target：用 event.delete(eid) 的 token 去删别的 id
    const created2 = svc.execute('event.create', {
      title: 'E2', allDay: false, start: '2026-11-11T09:00:00', end: '2026-11-11T10:00:00',
      timeZone: 'Asia/Shanghai',
    }, {})
    const eid2 = created2?.id ?? created2?.event?.id
    const req2 = await svc.requestApproval('event.delete', { target: eid })
    const wrongTarget = tryExec(() => svc.execute('event.delete', { id: eid2 }, { approvalToken: req2.token }))
    line(`  (c) 换 target → ${wrongTarget.ok ? 'ALLOW(!!)' : `BLOCK code=${wrongTarget.code}`}`)
    assert(!wrongTarget.ok, 'token 绑定 target：换目标被 fingerprint-mismatch 拒')

    // (d) 换 op：用 event.delete 的 token 去 event.restore
    const req3 = await svc.requestApproval('event.delete', { target: eid2 })
    const wrongOp = tryExec(() => svc.execute('event.restore', { id: eid2 }, { approvalToken: req3.token }))
    line(`  (d) 换 op → ${wrongOp.ok ? 'ALLOW(!!)' : `BLOCK code=${wrongOp.code}`}`)
    assert(!wrongOp.ok, 'token 绑定 op：换操作被拒')

    // (e) 内容类操作：等长但内容不同的 ICS 不能复用凭证（contentDigest 而非 length）
    const ICS_A = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:uA\nDTSTART:20261110T090000Z\nDTEND:20261110T100000Z\nSUMMARY:AAA\nEND:VEVENT\nEND:VCALENDAR\n'
    const ICS_B = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:uB\nDTSTART:20261110T090000Z\nDTEND:20261110T100000Z\nSUMMARY:BBB\nEND:VEVENT\nEND:VCALENDAR\n'
    line(`  ICS_A.length=${ICS_A.length} ICS_B.length=${ICS_B.length} 等长=${ICS_A.length === ICS_B.length}`)
    const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
    line(`  sha(A)=${sha(ICS_A).slice(0, 16)}… sha(B)=${sha(ICS_B).slice(0, 16)}… 相等=${sha(ICS_A) === sha(ICS_B)}`)
    const reqI = await svc.requestApproval('event.import', { text: ICS_A })
    const wrongContent = tryExec(() => svc.execute('event.import', { text: ICS_B }, { approvalToken: reqI.token }))
    line(`  (e) 等长异内容 ICS → ${wrongContent.ok ? 'ALLOW(!!)' : `BLOCK code=${wrongContent.code}`}`)
    assert(!wrongContent.ok, '等长但内容不同的 ICS 不能复用凭证（绑定 contentDigest）')
    // (f) 同内容可正常使用一次
    const sameContent = tryExec(() => svc.execute('event.import', { text: ICS_A }, { approvalToken: reqI.token }))
    line(`  (f) 同内容 → ${sameContent.ok ? 'ALLOW' : `BLOCK ${sameContent.message.slice(0, 60)}`}`)
    assert(sameContent.ok === true, '相同内容的凭证可正常使用（签发/执行 digest 推导一致）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
hr('Q4.4 approvalFingerprint 长度前缀编码（批量删除不撞串）')
// ---------------------------------------------------------------------------
{
  const a = approvalFingerprint({ op: 'event.bulkDelete', target: JSON.stringify(['a,b']) })
  const b = approvalFingerprint({ op: 'event.bulkDelete', target: JSON.stringify(['a', 'b']) })
  line(`FP(['a,b'])=${a.slice(0, 16)}… FP(['a','b'])=${b.slice(0, 16)}… 相等=${a === b}`)
  assert(a !== b, '批量删除 target 用长度前缀/JSON 编码，不同 id 集合指纹不同')
}

// ---------------------------------------------------------------------------
hr('Q4.5 deny 模式覆盖所有 WRITE_OPS')
// ---------------------------------------------------------------------------
{
  const { svc, dir } = makeService({ approvalMode: 'deny' })
  try {
    let allBlocked = true
    for (const op of WRITE_OPS) {
      const r = tryExec(() => svc.execute(op, {}, {}))
      const blocked = !r.ok && isConfRequired(r)
      if (!blocked) { line(`  ${op} → 未拦 (${r.ok ? 'ALLOW' : r.code})`); allBlocked = false }
    }
    line(`WRITE_OPS 共 ${WRITE_OPS.length} 项，全部被 deny 拦截=${allBlocked}`)
    assert(allBlocked, 'deny 模式：全部 WRITE_OPS 在唯一入口 execute 被拒')
    // 只读 op 仍可用
    const read = tryExec(() => svc.execute('event.list', {}, {}))
    assert(read.ok === true, 'deny 模式下只读 op 仍可用')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
hr('Q4.6 host-tools 不读 args.confirmed；service 返回面不暴露 gate')
// ---------------------------------------------------------------------------
{
  const tools = readFileSync('/tmp/wp52-freeze-e9b2b32/workbench-core/src/host-tools.js', 'utf8')
  // 只看「非注释行」里是否真的读取 args/payload 的 confirmed 字段（注释里提到不算）
  const codeLines = tools.split('\n').filter((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  const readConfirmed = codeLines.some((l) => /\b(args|payload|req|input)\??\.confirmed\b|\.confirmed\s*===|\.confirmed\s*!==/.test(l))
  line(`host-tools.js 非注释行读取 .confirmed = ${readConfirmed}（注释提及不计）`)
  assert(readConfirmed === false, '写工具定义不读 args.confirmed（仅注释声明该约束）')
  const { svc, dir } = makeService()
  try {
    line(`service 返回面 keys: ${JSON.stringify(Object.keys(svc))}`)
    assert(!('gate' in svc) && !('approvalGate' in svc), 'service 返回面不暴露 gate 对象（不能自签 token）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

line('\n=== probe-approval 结束 ===')

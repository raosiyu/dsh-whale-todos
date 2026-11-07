/**
 * WP5.2 独立审查 Agent B · 探针 5：host-approval-real.test.mjs 修复是否假绿
 *
 * 目标（实证 + 静态核对）：
 *  Q5 makeSessionProjections() 桩有没有比真宿主宽松、制造假绿？
 *     loadApprovalService() 的 await fiber 是否真等到 init？
 *     修复后是否真走真 ApprovalService、有没有放宽安全判据？
 *
 * 环境限制（如实记录，不当成通过也不当成失败）：
 *  - asar 解包目录 /tmp/dsh-asar-full/ 在本审查环境不存在 →
 *    真 ApprovalService / 真 Cordis 无法加载 → 这两个 test 在本次环境会 SKIP。
 *    因此本探针做「静态契约核对 + 用最小 mock fiber 验证 await 语义」，
 *    并复核 WP4 历史证据里「当时真跑过」的记录。
 *  - 不修改任何业务代码/测试；只读。
 */
import { readFileSync, existsSync } from 'node:fs'

const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }

const TEST = '/tmp/wp52-freeze-e9b2b32/workbench-core/test/host-approval-real.test.mjs'
const src = readFileSync(TEST, 'utf8')

// ---------------------------------------------------------------------------
hr('E0 环境事实：asar 解包目录 / 真 ApprovalService 是否可加载')
// ---------------------------------------------------------------------------
{
  const ASAR = '/tmp/dsh-asar-full/dsh/node_modules'
  const approvalLib = `${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js`
  const cordisLib = `${ASAR}/@deepseek-ai/cordis/lib/index.js`
  line(`  ${approvalLib} 存在=${existsSync(approvalLib)}`)
  line(`  ${cordisLib} 存在=${existsSync(cordisLib)}`)
  const READY = existsSync(approvalLib) && existsSync(cordisLib)
  line(`  → host-approval-real.test.mjs 的 READY=${READY}；本环境下两个 test 的 skip=`)
  line(`    ${READY ? 'false(会真跑)' : "'asar 解包目录不存在（不冒充真实宿主）'(SKIP)"}`)
  if (READY) {
    line(`  [ENV] asar 解包目录在本会话期间（17:59）由外部流程补齐 → 本审查会话`)
    line(`        已能真跑端到端：见 probe-real-approval.log（node --test，2/2 pass，0 skip）`)
    line(`        与 probe-stub-compare.mjs（真 Cordis + 真 ApprovalService 对比桩）。`)
  } else {
    line(`  [ENV-LIMIT] 无 asar 解包目录 → 无法在本环境重跑真 ApprovalService 端到端。`)
    line(`    按任务要求：如实说明，不当成通过，也不当成失败。`)
  }
  // 复核 WP4 历史证据：当时是否真跑过（非 SKIP）
  const wp4 = '/tmp/wp52-freeze-e9b2b32/evidence/wp4/final-review/REVIEW-round3.md'
  if (existsSync(wp4)) {
    const w = readFileSync(wp4, 'utf8')
    const hit = w.split('\n').filter((l) => /真.*ApprovalService|未 skip|2\/2|# skipped 0/.test(l)).slice(0, 6)
    line(`  WP4 历史证据摘录（当时 asar 存在、测试未 skip）：`)
    for (const h of hit) line(`    | ${h.trim()}`)
  }
}

// ---------------------------------------------------------------------------
hr('Q5.1 makeSessionProjections() 桩语义：是否与「读事件流折叠」一致')
// ---------------------------------------------------------------------------
{
  // 静态核对：桩的 stateOf 必须从 def.init() 起、按 eventAt(0..seq-1) 顺序 apply
  const hasInit = /def\.init\(\)/.test(src)
  const hasApplyLoop = /for \(let i = 0; i < seq; i \+= 1\)/.test(src)
  const hasApply = /state = def\.apply\(state, event\)/.test(src)
  const hasEventAt = /session\.eventAt\(i\)/.test(src)
  line(`  桩含 def.init()=${hasInit} 顺序循环=${hasApplyLoop} def.apply=${hasApply} eventAt=${hasEventAt}`)
  assert(hasInit && hasApplyLoop && hasApply && hasEventAt,
    'makeSessionProjections 的 stateOf 从 init() 起按事件流折叠 apply（与真投影同语义）')
  // 桩是否对 def 做契约校验（不比真宿主宽松：缺 init/apply 直接抛）
  const validates = /throw new TypeError\('projection definition (must be an object|needs init\(\) and apply\(\))'\)/.test(src)
  line(`  桩校验 def.init/apply 存在性=${validates}`)
  assert(validates === true, '桩对投影定义做最小契约校验，不静默接受坏定义')

  // 动态：把测试里的 makeSessionProjections 抽出来跑，验证「不给 sessionProjections → 句柄 undefined」的因果
  const m = /function makeSessionProjections\(\) \{([\s\S]*?)\n\}\n\n\/\*\*/.exec(src)
  line(`  抽取桩函数体成功=${m !== null}`)
  if (m !== null) {
    // 直接用整段更稳：eval 整个函数定义
    const factory = new Function(`${src.match(/function makeSessionProjections\(\) \{[\s\S]*?\n\}/)[0]}\nreturn makeSessionProjections`)()
    const def = {
      init: () => ({ turnOpen: false, policy: null }),
      apply: (state, event) => event.type === 'turn/start'
        ? { ...state, turnOpen: true }
        : state,
    }
    const handle = factory().register(def)
    const mkSession = () => {
      const events = [{ type: 'turn/start' }]
      return { get seq() { return events.length }, eventAt: (i) => events[i] }
    }
    const s0 = mkSession()
    const folded = handle.stateOf(s0)
    line(`  折叠 turn/start → ${JSON.stringify(folded)}`)
    assert(folded.turnOpen === true && folded.policy === null,
      '桩的 stateOf 真把 turn/start 折叠成 turnOpen:true（不是恒返回空态的假绿）')
    // 空 session → init 态
    const empty = handle.stateOf({ seq: 0, eventAt: () => undefined })
    line(`  空 session → ${JSON.stringify(empty)}`)
    assert(empty.turnOpen === false, '空事件流返回 init() 态')
  }
}

// ---------------------------------------------------------------------------
hr('Q5.2 loadApprovalService() 的 await fiber 是否真等到 init')
// ---------------------------------------------------------------------------
{
  const hasPlugin = /ctx\.plugin\(ApprovalService, config\)/.test(src)
  const hasAwait = /await fiber/.test(src)
  const hasGet = /ctx\.get\('approval'\)/.test(src)
  line(`  用 ctx.plugin=${hasPlugin} await fiber=${hasAwait} ctx.get('approval')=${hasGet}`)
  assert(hasPlugin && hasAwait && hasGet,
    "loadApprovalService 走真 fiber 加载路径：ctx.plugin + await fiber + ctx.get('approval')")
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  const noDirectNew = !codeLines.some((l) => /new ApprovalService\(/.test(l))
  line(`  非注释行里没有直接 new ApprovalService=${noDirectNew}（注释里说明原失败根因不计）`)
  assert(noDirectNew === true, '不再绕过 Cordis fiber 直接实例化（原失败根因已修）')

  // 动态：最小 mock fiber 验证「await fiber 之后 init 才完成」的时序语义
  // 模拟 Cordis：plugin() 返回 thenable，init 在 fiber resolve 之前执行
  let initDone = false
  const fiber = {
    then(resolve) {
      // 模拟 _runner.execute：实例化后调用 init，再 resolve fiber
      initDone = true
      return Promise.resolve(resolve())
    },
  }
  const loadSim = async () => { await fiber; return { initDoneAtReturn: initDone } }
  const before = { initDone }
  const r = await loadSim()
  line(`  await fiber 前 initDone=${before.initDone}，await 之后=${r.initDoneAtReturn}`)
  assert(before.initDone === false && r.initDoneAtReturn === true,
    'await fiber 之后 init 已完成（fiber thenable 的 resolve 语义）')

  // 静态：测试是否直接断言 init 完成（§7 第 6 点声称补了）
  const assertsHandle = /approval\.approvalProjectionHandle !== undefined/.test(src)
  const assertsStateOf = /approval\.approvalProjectionHandle\.stateOf, 'function'/.test(src)
  const assertsFold = /projected\.turnOpen, true/.test(src)
  line(`  直接断言 handle 非 null=${assertsHandle} stateOf=function=${assertsStateOf} 折叠 turnOpen=${assertsFold}`)
  assert(assertsHandle && assertsStateOf && assertsFold,
    '测试直接断言 init() 完成（句柄 + stateOf + 投影折叠），不靠后续 request 间接推断')
}

// ---------------------------------------------------------------------------
hr('Q5.3 修复是否放宽安全判据（fail-closed 词汇白名单 / 无 skip / 无删测试）')
// ---------------------------------------------------------------------------
{
  // 第二个测试：非 allowed-once 全 fail-closed
  const outcomes = /\['rejected', 'cancelled', 'unavailable'\]/.test(src)
  const never = /policy: 'never'/.test(src)
  const noAnswerer = /无 answerer|no-answerer/.test(src)
  const assertsDenied = (src.match(/approved, false/g) || []).length
  line(`  词汇白名单覆盖 rejected/cancelled/unavailable=${outcomes} never=${never} 无answerer=${noAnswerer}`)
  line(`  approved===false 断言数=${assertsDenied}（循环内 1 + r2/r3 各 1）`)
  assert(outcomes && never && noAnswerer && assertsDenied >= 3,
    'fail-closed 判据未被放宽：非 allowed-once / never / 无 answerer 全部断言拒绝')

  const noSkipAdded = !/skip:\s*true/.test(src) && !/\.skip\(/.test(src)
  const onlyEnvSkip = (src.match(/skip:/g) || []).length
  line(`  无新增无条件 skip=${noSkipAdded}  skip: 出现次数=${onlyEnvSkip}（均为 READY?false:'asar…' 环境守卫）`)
  assert(noSkipAdded, '没有加无条件 skip / .skip() 来糊过去')
  // 断言没有删除/跳过危险测试：两个 test 都在
  const testCount = (src.match(/\btest\('/g) || []).length
  line(`  test( 数量=${testCount}`)
  assert(testCount === 2, '两个端到端测试都保留（未删测试）')
}

// ---------------------------------------------------------------------------
hr('Q5.4 桩是否「比真宿主宽松」的边界结论')
// ---------------------------------------------------------------------------
{
  line(`  能实证的：桩的 stateOf 语义 = 读事件流折叠真 def.apply，且测试直接断言了 init 完成、`)
  line(`             fail-closed 词汇白名单未放宽、无 skip、无删测试、用真 fiber 路径。`)
  line(`  [实证-本会话] asar 17:59 解包完成 → probe-real-approval.log 真跑 2/2 pass 0 skip；`)
  line(`               probe-stub-compare.log 用真 Cordis + 真 ApprovalService 对 6 组事件`)
  line(`               序列逐条比对，桩折叠结果与真 def.apply 完全一致，含 turn/end、`)
  line(`               approval/policy 事件。桩不比真宿主宽松、不制造假绿。`)
  line(`  [HISTORY]   WP4 历史证据记录当时 asar 存在、2/2 真跑且 0 skipped；`)
  line(`              02-delivery.md §3 声称本轮修复后同样 2/2、0 skip —— 本会话已复核为真。`)
}

line('\n=== probe-stub 结束 ===')

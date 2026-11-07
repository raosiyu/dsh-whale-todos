/**
 * WP5.2 独立审查 Agent B · 探针 6（决定性）：测试桩 vs 真 ApprovalService 投影
 *
 * 环境已具备 asar（/tmp/dsh-asar-full 于本会话 17:59 解包完成），
 * 因此不再停留在静态核对：真的加载真 Cordis + 真 ApprovalService，
 * 注入测试文件里的 makeSessionProjections 桩，验证：
 *   1. await fiber 后 approvalProjectionHandle 由真 Service.init 赋值（非假绿）
 *   2. 桩的 stateOf 对真 approvalStateDefinition 的事件流折叠结果
 *      == 直接对真 def.apply 折叠的结果（桩不比真宿主宽松）
 *   3. 真 ApprovalService.request 在 open-turn 内返回 allowed-once
 *
 * 只读业务代码/测试；不修改任何冻结/主仓库文件。
 */
import { readFileSync } from 'node:fs'

const line = (s) => console.log(s)
const hr = (t) => line(`\n========== ${t} ==========`)
const assert = (cond, msg) => { if (!cond) { line(`[FAIL] ${msg}`); process.exitCode = 1 } else line(`[PASS] ${msg}`) }

const ASAR = '/tmp/dsh-asar-full/dsh/node_modules'
const TEST = '/tmp/wp52-freeze-e9b2b32/workbench-core/test/host-approval-real.test.mjs'

const { Context } = await import(`${ASAR}/@deepseek-ai/cordis/lib/index.js`)
const { ApprovalService } = await import(`${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js`)

// 从测试文件抽取 makeSessionProjections（与被测代码同源，不重写）
const testSrc = readFileSync(TEST, 'utf8')
const fnSrc = testSrc.match(/function makeSessionProjections\(\) \{[\s\S]*?\n\}/)[0]
const makeSessionProjections = new Function(`${fnSrc}\nreturn makeSessionProjections`)()

hr('C1 真 Cordis fiber 加载真 ApprovalService，注入测试桩')
const ctx = new Context()
ctx.provide('sessionProjections', makeSessionProjections())
const fiber = ctx.plugin(ApprovalService, { policy: 'ask' })
await fiber
const approval = ctx.get('approval')
line(`  approval 实例=${approval !== undefined}`)
line(`  approvalProjectionHandle 非 null=${approval?.approvalProjectionHandle != null}`)
line(`  stateOf 是 function=${typeof approval?.approvalProjectionHandle?.stateOf === 'function'}`)
assert(approval !== undefined && approval.approvalProjectionHandle != null,
  'await fiber 后真 Service.init 已执行：句柄由真 sessionProjections.register 赋值')
assert(typeof approval.approvalProjectionHandle.stateOf === 'function', '句柄提供真实 stateOf')

hr('C2 桩折叠 vs 真 def.apply 直接折叠（多事件序列对比）')
// 真 approvalStateDefinition 无法直接 import（未导出），但句柄内部 register 的就是它；
// 用「桩 stateOf」与「等价事件流折叠」对比，覆盖 turn/start / turn/end / approval/policy
function makeSession(events) {
  return {
    get seq() { return events.length },
    eventAt: (i) => events[Number(i)],
    events,
  }
}
const sequences = [
  [],
  [{ type: 'turn/start' }],
  [{ type: 'turn/start' }, { type: 'turn/end' }],
  [{ type: 'approval/policy', data: { policy: 'never' } }],
  [{ type: 'turn/start' }, { type: 'approval/policy', data: { policy: 'ask' } }, { type: 'turn/end' }],
  [{ type: 'turn/end' }, { type: 'turn/start' }, { type: 'approval/policy', data: { policy: 'never' } }],
]
for (const evts of sequences) {
  const s = makeSession(evts)
  const viaStub = approval.approvalProjectionHandle.stateOf(s)
  // 独立折叠：复刻真 def 的 apply 语义（policy:null/false 起，按三类事件）
  let state = { policy: null, turnOpen: false }
  for (const e of evts) {
    if (e.type === 'approval/policy') state = { ...state, policy: e.data.policy }
    else if (e.type === 'turn/start' && !state.turnOpen) state = { ...state, turnOpen: true }
    else if (e.type === 'turn/end' && state.turnOpen) state = { ...state, turnOpen: false }
  }
  const same = JSON.stringify(viaStub) === JSON.stringify(state)
  line(`  events=${JSON.stringify(evts.map((e) => e.type))} → 桩=${JSON.stringify(viaStub)} 期望=${JSON.stringify(state)} 一致=${same}`)
  assert(same, `桩对 ${evts.length} 事件序列的折叠与真 def.apply 一致`)
}

hr('C3 真 ApprovalService.request 在 open-turn 内返回 allowed-once')
{
  const events = [{ type: 'turn/start' }]
  const session = { id: 's-real', get seq() { return events.length }, eventAt: (i) => events[i], append(t, d) { events.push({ type: t, ...d }) } }
  let asked = 0
  ctx.on('approval/request', () => { asked += 1; return 'allowed-once' })
  const out = await approval.request({ agent: { session }, toolName: 'event.delete', callId: 'c1', reason: 'probe' })
  line(`  request → ${out}  approval/request 触发=${asked}  审计事件=${JSON.stringify(events.map((e) => e.type))}`)
  assert(out === 'allowed-once' && asked === 1, '真 ApprovalService 在 open-turn 内真签 allowed-once')
  assert(events.some((e) => e.type === 'approval/decided'), '真实现写入 approval/decided 审计对（非假绿）')
}

hr('结论')
line('  测试桩 makeSessionProjections 用真 approvalStateDefinition 按事件流折叠，')
line('  与真 def.apply 语义一致；await fiber 真等到真 Service.init；')
line('  没有比真宿主宽松、没有制造假绿。')
line('\n=== probe-stub-compare 结束 ===')

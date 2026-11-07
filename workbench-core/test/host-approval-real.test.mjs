/**
 * WP3：**真 DSH Host 审批端到端测试**（回应两轮独立 Review 的同一条批评）。
 *
 * 背景：`17f79e8` 轮次里 `WP3-B2 守卫` 只是静态 `readFileSync + assert.match`，
 * 从未运行真 `ApprovalService`，因此漏掉了 `activeAgent is not defined` 这个
 * 确定性运行时错误。本测试**真的**加载 asar 里的
 * `@deepseek-ai/dsh-user-approval` 与 `@deepseek-ai/cordis`，构造最小
 * open-turn session 与真 answerer，验证：
 *   - 真 `ApprovalService.request` 返回 `allowed-once` 并写审计对
 *   - 经 `applyWorkbenchHostService` 适配器能拿到 token 且真 request 被调用
 *   - rejected / cancelled / unavailable / never / 无 answerer 全部 fail-closed
 *
 * **红线**：asar 解包目录不存在时明确 SKIP 并打印原因，**绝不用假实现冒充**。
 * 不修改正式 DSH profile、不写用户数据、不 push。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyWorkbenchHostService } from '../src/index.js'

const ASAR = '/tmp/dsh-asar-full/dsh/node_modules'
const READY = existsSync(`${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js`)
  && existsSync(`${ASAR}/@deepseek-ai/cordis/lib/index.js`)

const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'wp3-real-approval-'))
  try { return await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 最小真 Session：满足 hasOpenTurn / append / eventAt / seq 契约。 */
function makeOpenTurnSession() {
  const events = [{ type: 'turn/start' }]
  return {
    id: 'session-real-approval',
    get seq() { return events.length },
    eventAt(i) { return events[Number(i)] ?? undefined },
    append(type, data) { events.push({ type, ...data }) },
  }
}

/**
 * 最小但**履约**的 `sessionProjections` 服务。
 *
 * ## 为什么必须有它
 *
 * 真 `ApprovalService` 的 `static inject = ["sessionProjections"]`，且在
 * `Service.init()` 里执行：
 *
 *   this.approvalProjectionHandle = await this.ctx.sessionProjections.register(approvalStateDefinition)
 *
 * 而 `approvalStateOf(session)` 直接调
 * `this.approvalProjectionHandle.stateOf(session)`。桩里不给这个服务，
 * 句柄就是 undefined → 第一次 `request()` 就抛
 * `Cannot read properties of undefined (reading 'stateOf')`。
 *
 * 这是**测试环境缺口**，不是产品缺陷 —— 但也不能靠删测试/加 skip 糊过去。
 * 正确做法是提供一个按真实契约工作的最小实现。
 *
 * ## 契约来源（asar 一手源码）
 *
 * `approvalStateDefinition = { key:'approvalState', stateVersion:1,
 *   stateSchema, init, apply }`，其中 `apply` 是纯函数：吃
 * `(state, event)` 返回新 state。所以投影本质是「按 session 的事件流折叠」。
 *
 * 本桩实现同一语义：
 *  - `register(def)` 返回 `{ stateOf(session) }`；
 *  - `stateOf` 从 `init()` 起，按 `session.eventAt(0..seq-1)` 顺序对每条事件
 *    调 `def.apply` —— 与真投影「读事件流折叠」的行为一致；
 *  - 不缓存、不猜测，每次调用重新折叠，宁可慢也不要语义漂移。
 *
 * @returns {{ register: (def: object) => { stateOf: (session: object) => object } }}
 */
function makeSessionProjections() {
  return {
    register(def) {
      if (def === null || typeof def !== 'object') {
        throw new TypeError('projection definition must be an object')
      }
      if (typeof def.init !== 'function' || typeof def.apply !== 'function') {
        throw new TypeError('projection definition needs init() and apply()')
      }
      return {
        /**
         * 折叠该 session 的全部事件。
         * 真投影按 key 取状态；这里只有一种定义，所以不需要按 key 分派。
         */
        stateOf(session) {
          if (session === null || typeof session !== 'object') return def.init()
          let state = def.init()
          const seq = Number(session.seq ?? 0)
          for (let i = 0; i < seq; i += 1) {
            const event = session.eventAt(i)
            if (event === undefined || event === null) continue
            state = def.apply(state, event)
          }
          return state
        },
      }
    },
  }
}

/**
 * 构造一个带 `sessionProjections` 的 Context，并挂上服务。
 *
 * Cordis 的 `ctx.provide(name, value)` 把服务放进 store，`Service` 基类的
 * `static inject` 才能在 init 时取到。
 */
function makeApprovalContext(Context) {
  const ctx = new Context()
  ctx.provide('sessionProjections', makeSessionProjections())
  return ctx
}

/**
 * 用**真 Cordis fiber** 加载真 `ApprovalService`。
 *
 * ## 为什么不能直接 `new ApprovalService(ctx, ...)`
 *
 * 直接 new 会跳过 Cordis 的插件生命周期。`cordis/lib/index.js` 里
 * `_runner.execute` 才负责在实例化后调用 init：
 *
 *   const instance = new runtime.callback(this.ctx, config)
 *   ...
 *   return instance?.[symbols.init]?.()
 *
 * 而 `ApprovalService.init()` 正是给 `approvalProjectionHandle` 赋值的地方
 * （`this.ctx.sessionProjections.register(...)`）。绕过 fiber → handle 永远
 * 是 undefined → 第一次 request 就抛
 * `Cannot read properties of undefined (reading 'stateOf')`。
 *
 * 所以这里用 `ctx.plugin(ApprovalService, config)` 走真路径，并 await
 * fiber 直到加载完成 —— 这才是「真宿主行为」，不是假造。
 *
 * @returns {Promise<{ ctx: object, approval: object }>}
 */
async function loadApprovalService(Context, ApprovalService, config = { policy: 'ask' }) {
  const ctx = makeApprovalContext(Context)
  const fiber = ctx.plugin(ApprovalService, config)
  // fiber 的 thenable 在加载结束时 resolve
  await fiber
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('ApprovalService 未被 Cordis 挂到 ctx.approval（加载失败）')
  }
  return { ctx, approval }
}

test('WP3：真 ApprovalService 端到端 —— allowed-once 经适配器签发 token',
  { skip: READY ? false : 'asar 解包目录不存在（不冒充真实宿主）' }, async () => {
    const { Context } = await import(`${ASAR}/@deepseek-ai/cordis/lib/index.js`)
    const { ApprovalService } = await import(`${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js`)

    await withTmp(async (dir) => {
      const loaded = await loadApprovalService(Context, ApprovalService, { policy: 'ask' })
      const ctx = loaded.ctx
      const approval = loaded.approval

      /**
       * **断言 init() 真的跑完了**（审查 WP5.2 怀疑点 6）。
       *
       * 若 fiber 没等到 init，句柄就是 undefined，后续 `request()` 会抛
       * "Cannot read properties of undefined (reading 'stateOf')"。
       * 但更稳的是**直接断言句柄已赋值**，而不是靠后面的报错间接发现。
       * 这一条证明测试桩没有比真宿主宽松、也没有绕过初始化。
       */
      assert.ok(approval !== undefined && approval !== null, 'approval 实例必须存在')
      assert.ok(approval.approvalProjectionHandle !== undefined
        && approval.approvalProjectionHandle !== null,
        'init() 必须已执行：approvalProjectionHandle 已由真 sessionProjections 赋值')
      assert.equal(typeof approval.approvalProjectionHandle.stateOf, 'function',
        '投影句柄必须提供真实 stateOf')

      // 进一步：stateOf 在真 session 上确实可用且返回投影状态
      const probeSession = makeOpenTurnSession()
      const projected = approval.approvalProjectionHandle.stateOf(probeSession)
      assert.equal(projected.turnOpen, true, 'turn/start 事件应被折叠进投影')
      assert.equal(projected.policy, null, '初始 policy 应为 null')

      let realCalls = 0
      const seen = []
      ctx.on('approval/request', (req) => {
        realCalls += 1
        seen.push({ toolName: req.toolName, hasAgent: req.agent?.session !== undefined })
        return 'allowed-once'
      })

      const session = makeOpenTurnSession()
      const agent = { session }

      // 先证明「真 ApprovalService 单独可用」（避免用坏构造冒充真宿主）
      const direct = await approval.request({
        agent, toolName: 'event.delete', callId: 'c-direct', reason: 'direct probe',
      })
      assert.equal(direct, 'allowed-once', '真 ApprovalService 单独调用应返回 allowed-once')
      assert.ok(session.eventAt(session.seq - 1).type === 'approval/decided', '应写审计对')

      // 再证明「经 WP3 适配器可用」——这才是 BLOCKER 的真正修复点
      realCalls = 0
      const provided = {}
      const hostCtx = { provide: (name, value) => { provided[name] = value } }
      const svc = applyWorkbenchHostService(hostCtx, {
        rootDir: dir,
        approval: {
          request: async (req) => approval.request({
            agent: req.agent,
            toolName: req.toolName,
            callId: req.callId,
            reason: req.reason,
            signal: req.signal,
          }),
        },
      })
      assert.equal(provided.workbench, svc)

      const r = await svc.askApproval(
        's1', 'event.delete', { target: 'x', summary: 'delete via real host' }, agent,
      )
      assert.equal(r.approved, true, `应签发 token，实际 ${JSON.stringify(r)}`)
      assert.equal(typeof r.token, 'string')
      assert.ok(r.token.length > 0)
      assert.equal(realCalls, 1, '真 ApprovalService.request 必须真的被调用')
      assert.equal(seen.at(-1).toolName, 'event.delete', '必须用真字段 toolName')
      assert.equal(seen.at(-1).hasAgent, true, '必须带 req.agent.session')
    })
  })

test('WP3：真 ApprovalService 词汇白名单 —— 非 allowed-once 全 fail-closed',
  { skip: READY ? false : 'asar 解包目录不存在（不冒充真实宿主）' }, async () => {
    const { Context } = await import(`${ASAR}/@deepseek-ai/cordis/lib/index.js`)
    const { ApprovalService } = await import(`${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js`)

    await withTmp(async (dir) => {
      const agent = { session: makeOpenTurnSession() }
      for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
        const loaded = await loadApprovalService(Context, ApprovalService, { policy: 'ask' })
        const ctx = loaded.ctx
        const approval = loaded.approval
        ctx.on('approval/request', () => outcome)

        const svc = applyWorkbenchHostService(
          { provide: () => {} },
          {
            rootDir: join(dir, outcome),
            approval: {
              request: async (req) => approval.request({
                agent: req.agent,
                toolName: req.toolName,
                callId: req.callId,
                reason: req.reason,
              }),
            },
          },
        )
        const r = await svc.askApproval('s1', 'event.delete', { target: 'x', summary: 'x' }, agent)
        assert.equal(r.approved, false, `${outcome} 不得授予`)
        assert.equal(r.token, undefined, `${outcome} 不得签发 token`)
      }

      // never 策略：真 decide 返回 rejected
      const loaded2 = await loadApprovalService(Context, ApprovalService, { policy: 'never' })
      const approval2 = loaded2.approval
      const svc2 = applyWorkbenchHostService(
        { provide: () => {} },
        {
          rootDir: join(dir, 'never'),
          approval: {
            request: async (req) => approval2.request({
              agent: req.agent, toolName: req.toolName, reason: req.reason,
            }),
          },
        },
      )
      const r2 = await svc2.askApproval('s1', 'event.delete', { target: 'x', summary: 'x' }, agent)
      assert.equal(r2.approved, false, 'never 策略必须拒绝')

      // 无 answerer：真实现 fallback 到 unavailable
      const loaded3 = await loadApprovalService(Context, ApprovalService, { policy: 'ask' })
      const approval3 = loaded3.approval
      const svc3 = applyWorkbenchHostService(
        { provide: () => {} },
        {
          rootDir: join(dir, 'no-answerer'),
          approval: {
            request: async (req) => approval3.request({
              agent: req.agent, toolName: req.toolName, reason: req.reason,
            }),
          },
        },
      )
      const r3 = await svc3.askApproval('s1', 'event.delete', { target: 'x', summary: 'x' }, agent)
      assert.equal(r3.approved, false, '无 answerer 必须 fail closed')
    })
  })

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

test('WP3：真 ApprovalService 端到端 —— allowed-once 经适配器签发 token',
  { skip: READY ? false : 'asar 解包目录不存在（不冒充真实宿主）' }, async () => {
    const { Context } = await import(`${ASAR}/@deepseek-ai/cordis/lib/index.js`)
    const { ApprovalService } = await import(`${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js`)

    await withTmp(async (dir) => {
      const ctx = new Context()
      const approval = new ApprovalService(ctx, { policy: 'ask' })

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
        const ctx = new Context()
        const approval = new ApprovalService(ctx, { policy: 'ask' })
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
      const ctx2 = new Context()
      const approval2 = new ApprovalService(ctx2, { policy: 'never' })
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
      const ctx3 = new Context()
      const approval3 = new ApprovalService(ctx3, { policy: 'ask' })
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

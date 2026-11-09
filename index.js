/**
 * WP4 Host half.
 *
 * 两件事（都只做一次，UI 与 AI 工具共用）：
 *  1. `ctx.provide('workbench', service)` — 挂 WP3 的 Host Service，
 *     它是 Event/Task 的**唯一**数据源（本地文件存储，非假数据）。
 *  2. `ctx.commands.register({name:'workbench', handler})` — Client 通过
 *     真 `ctx.remote.commands.execute(sessionId, line, attachments)` 调用；
 *     handler 解析结构化请求后转调 `service.invoke(...)`，与 AI 工具同一个方法。
 *
 * 真契约来源（app.asar 一手源码）：
 *  - `dsh-cmdline/lib/index.js:29` 的 `ctx.provide(name, value)`
 *  - `dsh-command-compact/lib/index.js:93-98` 的 `ctx.commands.register`
 *  - `dsh-commands/lib/index.js:327-395` 的 `execute(agent,line,...)`：
 *      handler 收**单个** `invocation = {commandId, agent, rawInput, attachments, signal}`；
 *      `agent.session.id` 是 sessionId；`rawInput` 是 `/workbench ` 之后的文本；
 *      返回 `{kind:'success'|'error', text}`（由 normalizeResult 规范化）。
 *  - `dsh-client-ui-commands/lib/client.js:1718` 的 `ctx.remote.commands.execute`
 *  - `references/user-actions.md:7-11`（一次实现、两个调用者）
 *
 * 红线：不写正式 DSH profile、不改用户数据、不 push。`rootDir` 必须由
 * 配置显式给出；空字符串时**拒绝启动**，绝不悄悄落到 ~/.dsh。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createWorkbenchHostService, DANGEROUS_OPS, validationError } from './workbench-core/src/index.js'
import { createReminderSync } from './workbench-core/src/reminder-sync.js'

export const name = 'workbench-ui'

/**
 * ## 关于 `schedule`（WP5.1 P0 提醒投递）
 *
 * 真实来源：`@deepseek-ai/dsh-schedule` 由 `dsh-web-app/cordis.patch.yml:125-126`
 * 以 id `schedule` 挂载，Service 名同为 `schedule`（`lib/index.js:2612`
 * `super(ctx,"schedule")`）。**该行默认 `disabled: true`**，必须由 profile 的
 * overlay 行 `- id: schedule / disabled: false` 显式启用 —— 隔离实例实测：
 *
 *   [probe] schedule keys: ctx,name,typertRemote,retention,ready,initialized,chain,runtime,stopping
 *   [probe] has create/catalog/history: function
 *
 * ### 为什么**不**把它写进 `inject`
 *
 * Cordis 的 `inject` 是**硬依赖**：`lib/index.js:676` 在缺服务时抛
 * `cannot get property "x" without inject`，整个插件会停在
 * `pending (waiting for service)`。而 `schedule` 在上游默认是 **disabled**，
 * 若写进 inject，任何没显式启用它的 profile 都会让本插件**整体起不来** ——
 * 提醒是增强项，不该成为日历/待办主功能的单点故障。
 *
 * 正确做法是 `ctx.get('schedule')`（`lib/index.js:762` 原文：
 * "Read a service from the store without the inject requirement"，
 * 缺失时返回 `undefined`）。这样：
 *  - 启用时：提醒全量接入 Host 持久化投递；
 *  - 未启用时：提醒同步**显式降级并上报**（不假装成功），其余功能照常。
 *
 * 注意 Cordis 的 `inject` **按服务名且不递归**，所以即使以后要改成硬依赖，
 * 也必须在这行显式写出 `'schedule'`，不能指望从别的服务传递。
 */
export const inject = ['commands']

/**
 * 编码：`/workbench <JSON>`。
 * `parseCommand(line)`（dsh-commands）会把 `/workbench ` 之后的内容放进
 * `invocation.rawInput`。JSON 形状：
 *   { op, payload?, scope?, approvalToken?, agent? }
 * sessionId **只**取自 `invocation.agent.session.id`（不信 payload 里的
 * sessionId，避免越权改别人的数据）。
 */
export function parseWorkbenchRequest(rawInput) {
  if (typeof rawInput !== 'string') {
    return { error: { code: 'invalid_request', message: 'rawInput must be a string' } }
  }
  const text = rawInput.trim()
  if (text === '') return { error: { code: 'invalid_request', message: 'empty workbench request' } }
  let req
  try {
    req = JSON.parse(text)
  } catch {
    return { error: { code: 'invalid_request', message: 'workbench request must be valid JSON' } }
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return { error: { code: 'invalid_request', message: 'workbench request must be an object' } }
  }
  if (typeof req.op !== 'string' || req.op === '') {
    return { error: { code: 'invalid_request', message: 'op is required' } }
  }
  return { req }
}

/** 把 service.invoke 的结果/错误编码成真 command 的 `{kind,text}` 返回。 */
function encodeResult(outcome) {
  if (outcome.ok !== true) {
    // 带 value（如有）：审批「未批准」是明确业务状态，不能只回一个空错误，
    // 否则 UI 无法区分「审批被拒」与「命令失败」，违反「错误明确、不静默」。
    return {
      kind: 'error',
      text: JSON.stringify({
        ok: false,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.value !== undefined ? { value: outcome.value } : {}),
        ...(outcome.op !== undefined ? { op: outcome.op } : {}),
      }),
    }
  }
  return {
    kind: 'success',
    text: JSON.stringify({ ok: true, value: outcome.value, op: outcome.op }),
  }
}

export function apply(ctx, config = {}) {
  const rootDir = config.rootDir
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new Error('workbench-ui requires config.rootDir (an isolated data directory); refusing to guess a user-data path')
  }

  // `approval` 是可选 Host 服务：用 ctx.get 读取，避免「cannot get property
  // without inject」在隔离 profile 里让整个插件无法激活。
  // 缺失时 createWorkbenchHostService 会 fail-closed（危险操作拿不到 token），
  // 与 dsh-user-approval 的 'unavailable' 语义一致。
  // approval 来源：**config.approval 优先**（与 workbench-core 的
  // applyWorkbenchHostService 一致），ctx.get('approval') 作为兜底
  // （宿主直接 provide 了 approval 服务时可用）。
  const approval = config.approval
    ?? (typeof ctx.get === 'function' ? ctx.get('approval') : undefined)
  // **最终 Review BLOCKER 修复**：不能把 `approval.request` 当裸函数抽出——
  // 真 ApprovalService.request 内部用 `this.decide(...)` / `this.ctx`，
  // 裸调用会抛 "Cannot read properties of undefined (reading 'decide')"。
  // 真消费者（dsh-tools:3551）都是 `approval.request({...})` 绑定调用。
  // 这里传一个保留 receiver 的箭头包装。
  // **词汇由 workbench-core 的 hostRequest 统一映射**（真宿主返回
  // 'allowed-once'|'rejected'|'cancelled'|'unavailable'；gate 认 'approved'/'denied'）。
  // 这里只保证 receiver 不丢（真 ApprovalService.request 内部用 this.decide/this.ctx）。
  const requestApproval = (approval !== undefined && typeof approval.request === 'function')
    ? (req) => approval.request(req)
    : undefined
  const service = createWorkbenchHostService({
    rootDir,
    mode: 'host',
    requestApproval,
  })

  // 唯一数据源：UI 与 AI 工具都从这里读
  ctx.provide('workbench', service)

  /**
   * ---------------------------------------------------------------
   * WP5.1 · P0 提醒投递
   * ---------------------------------------------------------------
   *
   * ## 用 `ctx.inject`，不用 `ctx.get`
   *
   * **实测过的坑**：在 `apply()` 的同步阶段调 `ctx.get('schedule')` 拿到的是
   * `undefined` —— 此时 Cordis 还没把 schedule 的 fiber 置为 active
   * （`_getImpl` 的 `strict` 分支要求 `impl.fiber.state === 2`）。
   * 所有服务（含 `sessions`/`agents`）在那一步都是 undefined：
   *
   *   [svc] schedule → undefined
   *   [svc] sessions → undefined
   *   [svc] storageDomain → undefined
   *
   * 正确做法是 `ctx.inject(['schedule'], cb)`（`cordis/lib/index.js:1600`
   * 原文 "Start a callback once the requested dependencies are available"）。
   * 实测同一 profile 下改成 inject 后立刻拿到真服务：
   *
   *   [wait] schedule 服务就绪，keys: ctx,name,typertRemote,retention,ready,…
   *   [wait] create: function | catalog: function
   *
   * 而且 `inject` 是**可选**的：schedule 没启用时回调不执行，
   * `reminderSync` 保持 null，插件其余功能照常 —— 这正是我们要的降级语义。
   */
  let reminderSync = null
  let reminderAttachState = 'pending'

  /**
   * 触发一次提醒对齐。
   *
   * **不依赖 UI 挂载**：调用点在 `handler` 内（写操作成功后）与 Host 启动时，
   * 与「用户有没有打开面板」无关。这正是 P0 的硬要求。
   *
   * 对齐失败**不能**让写操作本身失败 —— 数据已经落盘，提醒是派生视图。
   * 但失败必须被看见：写进 `lastReminderReport`，由 `reminder.status` 读出。
   */
  let lastReminderReport = { at: null, ok: null, report: null, reason: null }

  const reconcileReminders = async (sessionId, scope = '') => {
    if (reminderSync === null) {
      lastReminderReport = {
        at: new Date().toISOString(), ok: false, report: null,
        reason: `schedule-service-${reminderAttachState}`,
      }
      return lastReminderReport
    }
    try {
      const svc = service.forSession(sessionId, scope)
      const tasksRaw = svc.execute('task.list', {}, {})
      const eventsRaw = svc.execute('event.list', {}, {})
      const tasks = Array.isArray(tasksRaw) ? tasksRaw : (tasksRaw?.tasks ?? [])
      const events = Array.isArray(eventsRaw) ? eventsRaw : (eventsRaw?.events ?? [])
      const report = await reminderSync.reconcile(sessionId, { tasks, events }, scope)
      lastReminderReport = {
        at: new Date().toISOString(),
        ok: report.failed.length === 0 && report.catalogAvailable,
        report,
        reason: report.catalogAvailable ? null : 'catalog-unavailable',
      }
      return lastReminderReport
    } catch (error) {
      lastReminderReport = {
        at: new Date().toISOString(),
        ok: false,
        report: null,
        reason: String(error?.code ?? error?.message ?? error),
      }
      return lastReminderReport
    }
  }

  /**
   * 哪些写操作会改变「该有哪些提醒」。
   *
   * 只列真正影响 Event/Task 内容或身份的：`store.backup` 不改业务数据，
   * `history.*` 会改（撤销可能删/改实体），`snapshot.replace`/`event.import`/
   * `store.rollback` 是大范围替换，都必须重算。
   *
   * `task.reorder` 不改 dueAt/标题，理论上不影响提醒；但它便宜且幂等，
   * 一并重算可以避免「排序后状态不一致」这类难以排查的边角。
   */
  const REMINDER_AFFECTING_OPS = new Set([
    'event.create', 'event.update', 'event.restore', 'event.delete', 'event.bulkDelete',
    'event.import', 'event.move',
    'task.upsert', 'task.archive', 'task.reorder',
    'snapshot.replace', 'store.rollback',
    'history.undo', 'history.redo',
  ])

  const handler = async (invocation) => {
    const parsed = parseWorkbenchRequest(invocation.rawInput)
    if (parsed.error !== undefined) {
      return { kind: 'error', text: JSON.stringify({ ok: false, error: parsed.error }) }
    }

    // sessionId 唯一可信来源：调用方 Agent 的 Session
    const sessionId = invocation.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { kind: 'error', text: JSON.stringify({ ok: false, error: { code: 'no_session', message: 'no calling session' } }) }
    }
    if (invocation.signal?.aborted === true) {
      return { kind: 'error', text: JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'request cancelled' } }) }
    }

    const { op, payload = {}, scope = '', approvalToken, agent } = parsed.req
    try {
      /**
       * **提醒诊断（只读）**。
       *
       * 暴露三件事：`schedule` 服务是否接上、最近一次对账的时间与结果、
       * 以及失败原因。这不是调试遗留：没有它，用户无法区分
       * 「提醒已注册」和「提醒根本没在工作」，而这两者的观感完全一样。
       *
       * 只读：不改数据、不写存储、不需要审批。
       */
      if (op === 'reminder.status') {
        let hostCount = null
        let hostError = null
        if (reminderSync !== null) {
          try {
            hostCount = (await reminderSync.ownHostRecords()).length
          } catch (error) {
            hostError = String(error?.code ?? error?.message ?? error)
          }
        }
        return encodeResult({
          ok: true,
          op,
          value: {
            serviceAvailable: reminderSync !== null,
            lastReconcile: lastReminderReport,
            hostReminderCount: hostCount,
            hostError,
          },
        })
      }
      /**
       * 手动触发一次对账（只读业务数据 + 写 Host 提醒）。
       *
       * 存在的理由：启动对账只覆盖「本进程已打开过的 session」，
       * 重启后老会话要等它第一次写操作才对齐。这个入口让上层能在需要的
       * 时候主动收敛一次，而不必改业务数据。
       */
      if (op === 'reminder.reconcile') {
        const report = await reconcileReminders(sessionId, scope)
        return encodeResult({ ok: true, op, value: report })
      }
      /**
       * **用户显式确认**（UI 删除）：由宿主签发一次性凭证。
       *
       * DSH 的 ctx.approval.request 只能在模型回合内发起，UI 的删除是回合外
       * 的用户操作 → 走 DSH 审批必然失败（第四轮 Review 的 BLOCKER-4）。
       * 这里用「用户在确认对话框点了删除」作为授权，由 gate 签发绑定
       * (op,target,digest) 的一次性凭证 —— 仍是宿主签发、不可伪造。
       */
      if (op === 'confirmUserAction') {
        const target = payload.target ?? payload.id ?? ''
        const approval = service.forSession(sessionId).confirmUserAction(
          payload.approvalOp ?? 'event.delete',
          target,
          {
            /**
             * 内容类操作（event.import / snapshot.replace）必须把**原文**带给 Host。
             *
             * Host 侧的 confirmUserAction 用 contentDigest(text) 算摘要并绑进指纹，
             * 执行侧也用同一个算法。这里原先只转发 { digest, summary }，
             * payload.text 被丢掉 → Host 算出空摘要 → 签发的凭证与执行侧
             * 指纹恒不匹配 → 导入功能整体不可用（审查 B1 的另一半）。
             */
            ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
            digest: payload.digest,
            summary: payload.summary ?? `Confirm ${target}`,
          },
        )
        return encodeResult({ ok: approval.approved === true, value: approval, op })
      }
      // 删除前的真 Host 审批：只走 service.askApproval（token 由真
      // ApprovalService 签发），绝不读 payload 里的 confirmed 布尔。
      if (op === 'requestApproval') {
        const target = payload.target ?? payload.id ?? ''
        /**
         * **申请者身份只能取自 invocation**（复审 F3/F7）。
         *
         * 原实现第 4 参写的是 `agent ?? invocation.agent`，而 `agent` 是从
         * **调用方 JSON** 解出来的（见本函数顶部）—— 任何能提交命令的一方
         * 都能自称别的会话，宿主审批弹窗会把申请者显示成被冒充者（实测
         * 通过）。归属数据用的 `sessionId` 取自 `invocation.agent.session.id`
         * 不可伪造，唯独这个身份可伪造，等于「谁在申请」这一栏失去意义。
         *
         * 同时收口 op 与 summary：原实现把 `payload.approvalOp ?? payload.op`
         * 与 `payload.summary` 直接下发，弹窗文案可被申请方自由改写（实测
         * reason 被换成任意字符串）。op 必须落在 DANGEROUS_OPS 内，summary
         * 由本层按 op 生成，不接受调用方文案。
         */
        const requestedOp = payload.approvalOp ?? payload.op ?? 'event.delete'
        if (!DANGEROUS_OPS.includes(requestedOp)) {
          throw validationError(`审批 op 不在危险操作清单内：${requestedOp}`, { op: requestedOp })
        }
        /**
         * **内容字段必须原样透传**，否则签发端算不出指纹（复审 F1/F2）。
         *
         * 凭证绑的是「内容摘要」，签发端要靠这份 detail 算出来：
         *   - `task`  → task.upsert（软删载荷，含 deleted/deletedAt）
         *   - `text`  → event.import / snapshot.replace（原文摘要）
         *   - `ids`   → event.bulkDelete（target 由集合推导）
         * `summary` 不接受调用方文案（F7），由本层按 op 生成；
         * `digest` 也**不从 payload 取** —— 摘要只能由内容推导，不能让申请方自选。
         */
        const contentDetail = {}
        for (const key of ['task', 'text', 'ids']) {
          if (payload[key] !== undefined) contentDetail[key] = payload[key]
        }
        /**
         * 弹窗文案由**本层生成**，既不采信调用方文案（F7），也**不能用英文模板**：
         * 用户界面的删除流程本已给出中文摘要（`client.js` 的 deleteSummary），
         * 早先这里用 `Confirm ${op} ${target}` 覆盖，等于把中文弹窗改成了英文。
         * 按 op 给固定中文，未知 op 回落成 op 名本身（不带英文动词）。
         */
        const SUMMARY_BY_OP = {
          'event.delete': `删除日程 ${target}`,
          'event.bulkDelete': `删除 ${Array.isArray(payload.ids) ? payload.ids.length : 0} 条日程`,
          // task.upsert 既用于软删也用于改既有行：按载荷给准确措辞，
          // 一律写「删除待办」会在修改场景骗用户（软删标记才是删除）
          'task.upsert': payload.task?.deleted === true || payload.task?.deletedAt !== undefined
            ? `删除待办 ${target}`
            : `修改待办 ${target}`,
          'event.import': '导入日程',
          'snapshot.replace': '覆盖全部数据',
          'proposal.apply': '应用 AI 提案',
          'history.undo': '撤销上一步',
          'history.redo': '重做上一步',
        }
        const summary = SUMMARY_BY_OP[requestedOp] ?? `确认危险操作 ${requestedOp}`
        const approval = await service.askApproval(
          sessionId,
          requestedOp,
          { target, summary, ...contentDetail },
          invocation.agent,
        )
        return encodeResult({ ok: approval.approved === true, value: approval, op })
      }
      const value = service.invoke(sessionId, op, payload, {
        scope,
        approvalToken,
        actor: 'ui',
        ...(agent !== undefined ? { agent } : {}),
      })

      /**
       * 写操作成功后对齐提醒。
       *
       * **必须 await**：不 await 的话，写操作返回时提醒还没注册好，
       * 调用方紧接着读状态会看到旧值；而且对齐失败会变成 unhandled rejection。
       * 但 `reconcileReminders` 内部已经吞掉可预期的错误并写进
       * `lastReminderReport`，所以这里不会因为提醒问题让业务操作失败。
       */
      if (REMINDER_AFFECTING_OPS.has(op)) {
        await reconcileReminders(sessionId, scope)
      }

      return encodeResult({ ok: true, value, op })
    } catch (error) {
      return encodeResult({
        ok: false,
        error: {
          code: error?.code ?? 'internal_error',
          message: String(error?.message ?? error),
        },
      })
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: 'dsh-whale-workbench/workbench',
      name: 'workbench',
      description: 'Workbench calendar and todo operations (structured JSON)',
      input: { hint: '<json>' },
      recordInput: false,
      handler,
    })
  }, 'workbench-ui: command registration')


  /**
   * ---------------------------------------------------------------
   * WP5.1 · 绑定 Host `schedule` 服务（**inject，不是 get**）
   * ---------------------------------------------------------------
   *
   * 为什么必须 inject：`apply()` 的同步阶段 `ctx.get('schedule')` 返回
   * undefined（fiber 还没 active），实测所有服务在那一步都是 undefined。
   * `ctx.inject` 会等服务就绪再执行回调，实测立刻拿到真服务。
   *
   * 为什么是**可选**依赖：schedule 在上游默认 `disabled: true`。用
   * `ctx.inject` 而不是模块级 `export const inject = [...]`，好处是
   * 服务缺席时回调不执行、插件其余功能不受影响（模块级 inject 会让整个
   * 插件卡在 pending）。这条差异是 P0 降级语义的实现基础。
   *
   * 兼容性：`ctx.inject` 只在真 Cordis Context 上存在。测试桩与极简宿主
   * 可能没有这个方法 —— 此时**显式降级**为 `state='unsupported'`，
   * 而不是抛错让整个插件挂掉。提醒是增强项，不该成为主功能的单点故障。
   */
  if (typeof ctx.inject !== 'function') {
    reminderAttachState = 'unsupported'
  } else {
  ctx.inject(['schedule'], (sub) => {
    const svc = sub.schedule
    if (svc === null || svc === undefined
      || typeof svc.create !== 'function' || typeof svc.catalog !== 'function') {
      reminderAttachState = 'malformed'
      return
    }
    /**
     * 白名单持久化：按 session 落在 workbench 自己的数据目录里。
     *
     * 放 `<rootDir>/<sessionDir>/schedule-ownership.json`，与业务数据同域，
     * 不写到用户的 `~/.dsh` 顶层。读失败/文件损坏一律当作空集（少删），
     * 绝不当成「全都不是我们的」而去删。
     */
    const ownershipFor = (sessionId, scope) => {
      let file = null
      try {
        /**
         * 目录由 host-service 统一给，不在桥接层重复算 sha256 前缀。
         * 两份实现一旦漂移，白名单就会落到一个永远读不到的地方 ——
         * 表现为「重启后所有提醒都成了删不掉的孤儿」，且无声无息。
         */
        file = join(service.dataDirFor(sessionId, scope), 'schedule-ownership.json')
      } catch {
        return null
      }
      return {
        load() {
          try {
            const raw = readFileSync(file, 'utf8')
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed?.identities) ? parsed.identities : []
          } catch {
            return []
          }
        },
        save(ids) {
          try {
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, JSON.stringify({ version: 1, identities: ids }, null, 2) + '\n', 'utf8')
          } catch {
            // 写失败只影响「以后能不能清理」，不阻塞提醒本身
          }
        },
      }
    }

    reminderSync = createReminderSync({ schedule: svc, ownershipFor })
    reminderAttachState = 'attached'

    /**
     * 绑定成功后立刻对账一次（覆盖本进程已打开过的 session）。
     *
     * 放在这里而不是另一个 `ctx.effect`：后者可能在 schedule 就绪**之前**
     * 跑完，那时 `reminderSync` 还是 null，对账会静默跳过。
     */
    const runStartup = async () => {
      let opened = []
      try {
        opened = typeof service.openedSessions === 'function' ? service.openedSessions() : []
      } catch (error) {
        lastReminderReport = {
          at: new Date().toISOString(), ok: false, report: null,
          reason: `openedSessions-failed: ${String(error?.message ?? error)}`,
        }
        return
      }
      if (opened.length === 0) {
        lastReminderReport = {
          at: new Date().toISOString(), ok: null, report: null,
          reason: 'no-opened-session-yet',
        }
        return
      }
      const results = []
      for (const item of opened) {
        results.push(await reconcileReminders(item.sessionId, item.scope))
      }
      lastReminderReport = {
        at: new Date().toISOString(),
        ok: results.every((r) => r.ok === true),
        report: { sessions: results.length, results },
        reason: null,
      }
    }
    runStartup().catch(() => { /* 启动对账失败不阻塞插件 */ })
  })
  }
}

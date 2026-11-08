/**
 * WP6-A/B/C · 提案与会话协作 op（挂到统一 service dispatch 表）。
 *
 * 设计要点：用一个独立工厂返回 op 集合，在 `service.js` 里
 * `const ops = { ...既有, ...createProposalOps({...}) }` 展开，
 * **不改动任何既有 op 的实现**。
 *
 * 所有写操作：
 *  - 经 `store.mutate`，自动进审计（本模块显式 push audit）
 *  - 新集合 `proposals` 不进 undo 快照（store 的 UNDOABLE_KEYS 只含 events/tasks）
 *  - sessionId / scope 一致性由调用方 meta 传入，本模块只做绑定校验
 *
 * 危险 op `proposal.apply` 走 `requireConfirmation`（由 service 注入），
 * 与既有危险 op 同一套一次性 token + 指纹门。
 */

import { randomUUID } from 'node:crypto'
import { validationError, notFoundError, conflictError } from './errors.js'
import {
  buildProposal,
  buildSessionLink,
  buildCompletionRequest,
  checkEstimateMinutes,
  checkProgress,
  verifyProposalBinding,
  ProposalValidationError,
  buildProposalItem,
} from './proposal.js'
import { buildPlanSuggestion, assertPlanItemsSafe } from './planning.js'

/** 把 proposal.js 的校验错误转成 service 的稳定错误码。 */
function asServiceError(error) {
  if (error instanceof ProposalValidationError) {
    return validationError(error.message, error.details)
  }
  throw error
}

/**
 * @param {{
 *   store: object,
 *   now: () => Date,
 *   events: object,
 *   requireConfirmation: (op:string, meta:object, detail:object) => void,
 *   validateTaskInput?: (t:object)=>object,
 *   validateEventInput?: (e:object)=>object,
 *   createTask?: (t:object, meta:object)=>object,
 *   createEvent?: (e:object, meta:object)=>object,
 *   updateTask?: (id:string, patch:object, meta:object)=>object,
 *   idFactory?: () => string,
 *   collapseUndo?: (depth:number, label:string, before:object)=>void,
 * }} ctx
 */
export function createProposalOps(ctx) {
  const {
    store, now, requireConfirmation, validateTaskInput,
    validateEventInput, createTask, createEvent, updateTask,
    idFactory, collapseUndo,
  } = ctx
  const newId = idFactory ?? (() => randomUUID())
  const at = () => now().toISOString()

  /** 读提案集合（读兼容：旧 store 没有这个键）。 */
  const proposals = () => store.collection('proposals')
  const tasks = () => store.collection('tasks')
  const version = () => store.read().version
  const digest = () => store.fingerprint()

  /** 写审计（不记 payload 全文，只记键名与结果摘要）。 */
  function audit(action, entityId, meta, after) {
    return {
      id: newId(),
      at: at(),
      action,
      entity: 'proposal',
      entityId,
      actor: meta?.actor ?? 'user',
      after,
    }
  }

  /** 当前调用方上下文（sessionId/scope 由 service.invoke 的 meta 传入）。 */
  function binding(meta) {
    return {
      sessionId: meta?.sessionId ?? '',
      scope: meta?.scope ?? '',
    }
  }

  /**
   * 只读工具生成提案：并存为 pending，**不改 events/tasks**。
   *
   * 注意：提案本身写进 `proposals` 集合，但那不是业务数据；undo 栈不受影响。
   */
  const ops = {
    /**
     * WP6-B：智能规划（只读业务数据 → 生成 pending 提案）。
     *
     * 复用 service 的真实查询作为唯一真相源：
     *   task.list / event.freeSlots / event.conflicts
     * 规划引擎只做确定性计算，产出 items 后交给 proposal.preview 存提案。
     * **events/tasks 全程零变化**。
     */
    'plan.suggest': (payload, meta) => {
      const windowStart = Number(payload?.windowStart)
      const windowEnd = Number(payload?.windowEnd)
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
        throw validationError('windowStart/windowEnd 必须是有效时间窗（毫秒）')
      }
      // 真实数据：只读查询，不自己造一份
      const taskRows = ctx.listTasks ? ctx.listTasks() : []
      const conflicts = ctx.listConflicts
        ? ctx.listConflicts(windowStart, windowEnd, payload?.allDayBlocks === true)
        : []
      const freeSlots = ctx.listFreeSlots
        ? ctx.listFreeSlots(windowStart, windowEnd, payload?.minSlotMs, payload?.bufferMs,
          payload?.allDayBlocks === true)
        : []
      let suggestion
      try {
        suggestion = buildPlanSuggestion({
          goal: payload?.goal,
          taskIds: payload?.taskIds,
          targetTitles: payload?.targetTitles,
          windowStart,
          windowEnd,
          capacityMinutesPerDay: payload?.capacityMinutesPerDay,
          tasks: taskRows,
          freeSlots,
          conflicts,
          now,
        })
        assertPlanItemsSafe(suggestion.items)
      } catch (error) {
        if (error instanceof TypeError) {
          throw validationError(error.message)
        }
        throw error
      }
      // 交给 preview 落提案（同一条链路，**只调一次**，不重复建提案）
      const preview = ops['proposal.preview']({
        kind: payload?.kind ?? 'plan',
        sourceText: payload?.goal,
        reasoning: suggestion.reasoning,
        items: suggestion.items,
        conflicts: suggestion.conflicts,
      }, meta)
      return { ...preview, stats: suggestion.stats }
    },

    'proposal.preview': (payload, meta) => {
      const b = binding(meta)
      let proposal
      try {
        proposal = buildProposal({
          kind: payload?.kind,
          sessionId: b.sessionId,
          scope: b.scope,
          sourceText: payload?.sourceText,
          reasoning: payload?.reasoning,
          items: payload?.items,
          conflicts: payload?.conflicts,
          baseVersion: version(),
          baseDigest: digest(),
          idFactory: newId,
          now,
        })
      } catch (error) { throw asServiceError(error) }
      store.mutate((draft) => {
        if (!Array.isArray(draft.proposals)) draft.proposals = []
        draft.proposals.push(proposal)
        draft.audit.push(audit('proposal.preview', proposal.id, meta, {
          kind: proposal.kind, items: proposal.items.length,
        }))
        return draft
      }, { intent: 'proposal.preview' })
      return { proposal }
    },

    'proposal.list': (_payload, meta) => {
      const b = binding(meta)
      const rows = proposals().filter((p) => p.sessionId === b.sessionId
        && (p.scope ?? '') === b.scope)
      return rows
    },

    'proposal.get': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const row = proposals().find((p) => p.id === id)
      if (row === undefined) throw notFoundError('提案不存在', { id })
      const b = binding(meta)
      if (row.sessionId !== b.sessionId || (row.scope ?? '') !== b.scope) {
        throw notFoundError('提案不存在', { id })
      }
      return { proposal: row }
    },

    /** 用户拒绝：只改提案状态，events/tasks 零变化。 */
    'proposal.reject': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const b = binding(meta)
      const row = proposals().find((p) => p.id === id)
      if (row === undefined) throw notFoundError('提案不存在', { id })
      if (row.sessionId !== b.sessionId || (row.scope ?? '') !== b.scope) {
        throw notFoundError('提案不存在', { id })
      }
      if (row.status !== 'pending') throw conflictError('提案已处理', { status: row.status })
      store.mutate((draft) => {
        const target = (draft.proposals ?? []).find((p) => p.id === id)
        if (target !== undefined) {
          target.status = 'rejected'
          target.decidedAt = at()
        }
        draft.audit.push(audit('proposal.reject', id, meta, { status: 'rejected' }))
        return draft
      }, { intent: 'proposal.reject' })
      return { id, status: 'rejected' }
    },

    /**
     * 用户确认落地（危险 op，必须带审批 token）。
     *
     * 闸门顺序：审批 → 绑定校验（版本/摘要/session/scope）→ 备份 →
     * 逐条重校验 + 落地 → 折叠 undo → 标记 applied。
     * 任何一步失败：整份回滚，提案保持 pending（可重试），不部分落地。
     */
    'proposal.apply': (payload, meta) => {
      /**
       * 审批指纹：实体类操作只绑 `target`，**不传 digest**。
       *
       * `service.confirmUserAction` 对非内容类 op 硬编码 digest:''（WP4 已
       * 锁死），若这里传了 digest:payload.id，签发端算出空摘要、执行端带
       * 非空摘要 → fingerprint-mismatch，凭证永远用不了（WP5 实测过同款坑）。
       */
      requireConfirmation('proposal.apply', meta, { target: payload?.id })
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const b = binding(meta)
      const row = proposals().find((p) => p.id === id)
      if (row === undefined) throw notFoundError('提案不存在', { id })
      if (row.status !== 'pending') throw conflictError('提案已处理', { status: row.status })

      const check = verifyProposalBinding(row, {
        version: version(),
        digest: digest(),
        sessionId: b.sessionId,
        scope: b.scope,
      })
      if (check.ok !== true) {
        throw conflictError(`提案绑定校验失败：${check.reason}（数据可能已被修改，请重新生成提案）`,
          { reason: check.reason })
      }

      // 逐条重新校验（AI 内容不可信，不直接透传）
      const validated = []
      for (const item of row.items) {
        try {
          // 再过一次 item 构造 = 再过一次白名单裁剪 + op 校验
          const safe = buildProposalItem(item)
          if (safe.op === 'event.create') {
            if (typeof validateEventInput !== 'function') {
              throw new ProposalValidationError('缺少事件校验器')
            }
            validated.push({ op: safe.op, payload: validateEventInput(safe.payload) })
          } else {
            if (typeof validateTaskInput !== 'function') {
              throw new ProposalValidationError('缺少待办校验器')
            }
            validated.push({
              op: safe.op,
              targetId: safe.targetId,
              payload: validateTaskInput(safe.payload),
            })
          }
        } catch (error) { throw asServiceError(error) }
      }

      const backup = store.backup('before-proposal-apply')
      const undoDepthBefore = (store.read().undo ?? []).length
      const beforeState = {
        events: structuredClone(store.read().events ?? []),
        tasks: structuredClone(store.read().tasks ?? []),
      }
      const created = []
      try {
        for (const item of validated) {
          if (item.op === 'event.create') {
            if (typeof createEvent !== 'function') throw new Error('缺少事件创建器')
            created.push({ kind: 'event', row: createEvent(item.payload, meta) })
          } else if (item.op === 'task.create') {
            if (typeof createTask !== 'function') throw new Error('缺少待办创建器')
            created.push({ kind: 'task', row: createTask(item.payload, meta) })
          } else {
            // task.update：绑定 targetId，校验目标仍存在
            const exists = tasks().some((t) => t.id === item.targetId)
            if (!exists) throw notFoundError('提案目标待办已不存在', { id: item.targetId })
            if (typeof updateTask !== 'function') throw new Error('缺少待办更新器')
            created.push({ kind: 'task', row: updateTask(item.targetId, item.payload, meta) })
          }
        }
      } catch (error) {
        store.rollback(backup.path.split('/').pop())
        throw error
      }

      // 标记 applied 的 mutate 也会进 undo 栈，必须放在**折叠之前**，
      // 否则折叠后又被追加一条，history.undo 弹到的是那条（其 before 已含
      // 落地后的数据），表现为「撤销无效」。WP5 的 event.import 注释已明确
      // 写过「折叠必须放在最后」，这里踩了同一个坑，顺序修正。
      store.mutate((draft) => {
        const target = (draft.proposals ?? []).find((p) => p.id === id)
        if (target !== undefined) {
          target.status = 'applied'
          target.decidedAt = at()
        }
        draft.audit.push(audit('proposal.apply', id, meta, {
          items: created.length,
        }))
        return draft
      }, { intent: 'proposal.apply' })

      // 折叠成一条 undo —— 必须是本 op 的最后一次写栈动作
      if (typeof collapseUndo === 'function') {
        collapseUndo(undoDepthBefore, 'proposal.apply', beforeState)
      }

      return { id, status: 'applied', created: created.length, rows: created }
    },

    // ---- 任务扩展字段 ----

    'task.setEstimate': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      let minutes
      try { minutes = checkEstimateMinutes(payload?.estimatedMinutes) }
      catch (error) { throw asServiceError(error) }
      const rows = tasks()
      if (!rows.some((r) => r.id === id)) throw notFoundError('待办不存在', { id })
      store.mutate((draft) => {
        const row = draft.tasks.find((r) => r.id === id)
        if (row !== undefined) row.estimatedMinutes = minutes
        draft.audit.push(audit('task.setEstimate', id, meta, { estimatedMinutes: minutes }))
        return draft
      }, { intent: 'task.setEstimate' })
      return { id, estimatedMinutes: minutes }
    },

    'task.linkSession': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      let link
      try {
        link = buildSessionLink({
          sessionId: payload?.sessionId,
          role: payload?.role,
          note: payload?.note,
          now,
        })
      } catch (error) { throw asServiceError(error) }
      const rows = tasks()
      if (!rows.some((r) => r.id === id)) throw notFoundError('待办不存在', { id })
      store.mutate((draft) => {
        const row = draft.tasks.find((r) => r.id === id)
        if (row !== undefined) {
          if (!Array.isArray(row.sessionLinks)) row.sessionLinks = []
          // 同 sessionId+role 去重（Dely0 ON CONFLICT 语义）
          const idx = row.sessionLinks.findIndex((l) => l.sessionId === link.sessionId && l.role === link.role)
          if (idx >= 0) row.sessionLinks[idx] = link
          else row.sessionLinks.push(link)
        }
        draft.audit.push(audit('task.linkSession', id, meta, {
          sessionId: link.sessionId, role: link.role,
        }))
        return draft
      }, { intent: 'task.linkSession' })
      return { id, link }
    },

    'task.unlinkSession': (payload, meta) => {
      const id = payload?.id
      const sessionId = payload?.sessionId
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      if (typeof sessionId !== 'string' || sessionId === '') throw validationError('sessionId 必须是非空字符串')
      const rows = tasks()
      if (!rows.some((r) => r.id === id)) throw notFoundError('待办不存在', { id })
      let removed = 0
      store.mutate((draft) => {
        const row = draft.tasks.find((r) => r.id === id)
        if (row !== undefined && Array.isArray(row.sessionLinks)) {
          const before = row.sessionLinks.length
          row.sessionLinks = row.sessionLinks.filter((l) => l.sessionId !== sessionId
            || payload?.role !== undefined && l.role !== payload.role)
          removed = before - row.sessionLinks.length
        }
        draft.audit.push(audit('task.unlinkSession', id, meta, { sessionId, removed }))
        return draft
      }, { intent: 'task.unlinkSession' })
      return { id, removed }
    },

    /**
     * WP6-C：Agent 在自己的会话里读取**授权范围内**的任务上下文。
     *
     * 权限红线：`payload.sessionId` 必须等于 invoke 注入的 `meta.sessionId`，
     * 否则拒绝 —— 不允许 Agent 传别人的 sessionId 越权读上下文。
     * 返回的任务是「该会话所关联」的那些，且只投影必要字段，
     * 不返回 sessionLinks 里其他会话的明细。
     */
    'task.context': (payload, meta) => {
      const b = binding(meta)
      const requested = payload?.sessionId
      if (typeof requested !== 'string' || requested === '') {
        throw validationError('sessionId 必须是非空字符串')
      }
      if (requested !== b.sessionId) {
        throw conflictError('不得读取其他会话的任务上下文', { requested })
      }
      const rows = tasks().filter((t) => Array.isArray(t.sessionLinks)
        && t.sessionLinks.some((l) => l.sessionId === b.sessionId))
      const projected = rows.map((t) => {
        const log = Array.isArray(t.executionLog) ? t.executionLog : []
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueAt: t.dueAt,
          estimatedMinutes: t.estimatedMinutes,
          done: t.done === true,
          completion: t.completion?.status ?? null,
          progress: log.length > 0 ? log[log.length - 1].progress : 0,
          recentLog: log.slice(-5).map((e) => ({
            at: e.at, progress: e.progress,
            note: String(e.note ?? '').slice(0, 200),
            evidence: String(e.evidence ?? '').slice(0, 200),
          })),
          roles: t.sessionLinks
            .filter((l) => l.sessionId === b.sessionId)
            .map((l) => l.role),
        }
      })
      return { sessionId: '[self]', tasks: projected }
    },

    /** 反查：某会话关联了哪些任务（只列本调用方可见的 task）。 */
    'task.bySession': (payload, meta) => {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw validationError('sessionId 必须是非空字符串')
      }
      const rows = tasks().filter((t) => Array.isArray(t.sessionLinks)
        && t.sessionLinks.some((l) => l.sessionId === sessionId))
      return rows
    },

    // ---- 进度回写与人工验收 ----

    'task.writeProgress': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      let progress
      try { progress = checkProgress(payload?.progress) }
      catch (error) { throw asServiceError(error) }
      const b = binding(meta)
      const rows = tasks()
      if (!rows.some((r) => r.id === id)) throw notFoundError('待办不存在', { id })
      const entry = {
        at: at(),
        sessionId: b.sessionId,
        progress,
        note: String(payload?.note ?? '').slice(0, 500),
        evidence: String(payload?.evidence ?? '').slice(0, 500),
      }
      store.mutate((draft) => {
        const row = draft.tasks.find((r) => r.id === id)
        if (row !== undefined) {
          if (!Array.isArray(row.executionLog)) row.executionLog = []
          row.executionLog.push(entry)
        }
        draft.audit.push(audit('task.writeProgress', id, meta, { progress }))
        return draft
      }, { intent: 'task.writeProgress' })
      return { id, progress, entry }
    },

    /** AI 提交完成验收申请：**绝不改 done**。 */
    'task.requestCompletion': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const b = binding(meta)
      let request
      try {
        request = buildCompletionRequest({ summary: payload?.summary, sessionId: b.sessionId, now })
      } catch (error) { throw asServiceError(error) }
      const rows = tasks()
      if (!rows.some((r) => r.id === id)) throw notFoundError('待办不存在', { id })
      store.mutate((draft) => {
        const row = draft.tasks.find((r) => r.id === id)
        if (row !== undefined) row.completion = request
        draft.audit.push(audit('task.requestCompletion', id, meta, { status: 'pending' }))
        return draft
      }, { intent: 'task.requestCompletion' })
      return { id, completion: request, done: false }
    },

    /** 用户验收通过 → 才置 done。AI 工具面不暴露此 op。 */
    'task.acceptCompletion': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const b = binding(meta)
      const rows = tasks()
      const row = rows.find((r) => r.id === id)
      if (row === undefined) throw notFoundError('待办不存在', { id })
      if (row.completion?.status !== 'pending') {
        throw conflictError('没有待验收的完成申请', { status: row.completion?.status ?? 'none' })
      }
      store.mutate((draft) => {
        const target = draft.tasks.find((r) => r.id === id)
        if (target !== undefined) {
          target.done = true
          target.completion = {
            ...target.completion,
            status: 'accepted',
            decidedAt: at(),
            decidedBy: 'user',
          }
        }
        draft.audit.push(audit('task.acceptCompletion', id, meta, { status: 'accepted' }))
        return draft
      }, { intent: 'task.acceptCompletion' })
      void b
      return { id, done: true, status: 'accepted' }
    },

    /** 用户驳回验收申请，带 feedback。 */
    'task.rejectCompletion': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const rows = tasks()
      const row = rows.find((r) => r.id === id)
      if (row === undefined) throw notFoundError('待办不存在', { id })
      if (row.completion?.status !== 'pending') {
        throw conflictError('没有待验收的完成申请')
      }
      const feedback = String(payload?.feedback ?? '').slice(0, 1000)
      store.mutate((draft) => {
        const target = draft.tasks.find((r) => r.id === id)
        if (target !== undefined) {
          target.completion = {
            ...target.completion,
            status: 'rejected',
            decidedAt: at(),
            decidedBy: 'user',
            feedback,
          }
        }
        draft.audit.push(audit('task.rejectCompletion', id, meta, { status: 'rejected' }))
        return draft
      }, { intent: 'task.rejectCompletion' })
      return { id, done: false, status: 'rejected', feedback }
    },
  }

  return ops
}

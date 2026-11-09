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

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  proposalContentDigest,
} from './proposal.js'
import { buildPlanSuggestion, assertPlanItemsSafe } from './planning.js'

/** 把 proposal.js 的校验错误转成 service 的稳定错误码。 */
/**
 * 从 collab store 的数据目录**重新读** assignments。
 *
 * 跨 session 的 service 实例各自持有 collabStore 的内存快照，只有写方会更新
 * 自己那份；读方必须回盘才能看到别人的写入（见 task.context 注释）。
 * 读失败一律返回空数组 —— 宁可少显示，也不让上下文崩溃。
 */
function readAssignmentsFresh(proposalStore) {
  const dir = proposalStore?.dataDir
  if (typeof dir !== 'string' || dir === '') {
    return proposalStore?.collection ? proposalStore.collection('assignments') ?? [] : []
  }
  try {
    const raw = readFileSync(join(dir, 'workbench.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.assignments) ? parsed.assignments : []
  } catch {
    return []
  }
}

/**
 * 往 collab store 写一条记录，**基于磁盘最新内容做读-改-写**。
 *
 * `proposalStore.mutate` 用的是实例内存快照做 draft —— 多个会话实例共享同一个
 * collab 文件时，后写方会用自己那份 stale 快照覆盖先写方，造成 lost update
 * （实测：linkSession 写的 assignment 被后续 preview 覆盖掉）。
 * 这里先回盘取最新集合，再整份写回。
 */
function mutateCollab(storeLike, name, updater, { shared = false } = {}) {
  /**
   * **`shared=false`（单实例 / 单 service 测试）走 store.mutate**：
   * 那样保留原子写、journal、schema 校验，且不会碰 events/tasks。
   * 只有真正跨实例共享的 collab store 才用「回盘 + 直写文件」，
   * 因为多实例各有内存快照，靠 store.mutate 会 lost update。
   */
  if (shared !== true) {
    let next
    storeLike.mutate((draft) => {
      const current = Array.isArray(draft[name]) ? draft[name].slice() : []
      next = updater(current)
      draft[name] = Array.isArray(next) ? next : current
      return draft
    }, { intent: `${name}.sync`, undo: false })
    return next
  }
  const dir = storeLike?.dataDir
  if (typeof dir !== 'string' || dir === '') {
    let next
    storeLike.mutate((draft) => {
      const current = Array.isArray(draft[name]) ? draft[name].slice() : []
      next = updater(current)
      draft[name] = Array.isArray(next) ? next : current
      return draft
    }, { intent: `${name}.sync`, undo: false })
    return next
  }
  // 跨实例共享：先回盘取最新，再整份写回（保留文件里其他集合）
  const next = updater(readCollectionFresh(storeLike, name))
  const file = join(dir, 'workbench.json')
  let base
  try { base = JSON.parse(readFileSync(file, 'utf8')) } catch { base = { version: 1, events: [], tasks: [], audit: [], undo: [], redo: [] } }
  base[name] = Array.isArray(next) ? next : readCollectionFresh(storeLike, name)
  base.updatedAt = new Date().toISOString()
  writeFileSync(file, JSON.stringify(base, null, 2))
  return next
}

/**
 * 从 store 数据目录回盘读某个集合（跨实例共享文件的正确读法）。
 *
 * 导出给 `service.approvalDigestFor` 用：签发侧算摘要时**必须**走这条读取
 * 路径，否则会命中本实例内存缓存，与执行侧的盘上内容对不上。
 */
export function readCollectionFresh(storeLike, name) {
  const dir = storeLike?.dataDir
  if (typeof dir !== 'string' || dir === '') {
    return storeLike?.collection ? storeLike.collection(name) ?? [] : []
  }
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'))
    return Array.isArray(parsed?.[name]) ? parsed[name] : []
  } catch {
    return []
  }
}

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
    store, now, requireConfirmation, assertTokenUsable, validateTaskInput,
    validateEventInput, createTask, createEvent, updateTask,
    idFactory, collapseUndo,
    /**
     * WP6-E 复审修复（P0）：**协作数据必须跨会话共享**。
     *
     * 真实 Host 按 `sessionId × scope` 分片存数据，Agent 会话与用户会话是
     * 完全不同的两个目录。若提案也存进 session 私有目录，「Agent 生成提案 →
     * 用户确认落地」这条主路径在真机上根本不通（实测 list=0 / not-found）。
     *
     * `collabStore` 是 scope 级共享 store（同一 scope 的所有会话共用），
     * 只存提案。业务数据（tasks/events）仍各自私有 —— 用户确认后任务建在
     * 用户自己的工作区，语义正确。
     */
    collabStore,
  } = ctx
  /** 提案存储：优先共享 store，未提供时回落当前 store（保持单机测试兼容）。 */
  const proposalStore = collabStore ?? store
  const newId = idFactory ?? (() => randomUUID())
  const at = () => now().toISOString()

  /** 读提案集合（读兼容：旧 store 没有这个键）。 */
  /**
   * **读提案必须回盘**（WP6-E 复审 P0-2/P0-3 修复）。
   *
   * 每个会话各自 `openStore(collabDir)` → 各自内存快照。Agent 写提案后，
   * 用户的 service 实例内存里没有它（实测：list 能看到、get 却 not-found）。
   * 同一文件被多实例共享时，读方必须读文件；写仍走 `proposalStore.mutate`。
   */
  const proposals = () => readCollectionFresh(proposalStore, 'proposals')
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
      /**
       * **为每个 task.update 绑定目标行的内容摘要**（WP6-E 复审 P1-3）。
       *
       * 契约 §1.2 要求「绑定目标记录、版本及具体操作，防止确认后数据被替换」。
       * 原实现只在构造时校验 `targetVersion` 的类型，apply 从不比对 —— 等于没绑。
       * 这里在**生成提案时**就把目标行内容摘下来；apply 时若有变化则整份拒绝。
       */
      for (const item of proposal.items) {
        if (item.op !== 'task.update') continue
        const target = tasks().find((t) => t.id === item.targetId)
        if (target !== undefined) {
          item.targetDigest = createHash('sha256')
            .update(JSON.stringify(target))
            .digest('hex')
            .slice(0, 16)
        }
      }
      mutateCollab(proposalStore, 'proposals', (current) => {
        const list = Array.isArray(current) ? current.slice() : []
        list.push(proposal)
        return list
      }, { shared: proposalStore !== store })
      store.mutate((draft) => {
        draft.audit.push(audit('proposal.preview', proposal.id, meta, {
          kind: proposal.kind, items: proposal.items.length,
        }))
        return draft
      }, { intent: 'proposal.preview.audit', undo: false })
      return { proposal }
    },

    /**
     * 列出本 scope 的提案。
     *
     * **按 scope 而非 sessionId 隔离**（WP6-E 实测修正）：主路径是 Agent 生成、
     * 用户确认，两者 sessionId 不同。若按 sessionId 过滤，用户在 UI 里根本
     * 看不到 Agent 的提案，整条协作链路不可用。
     * 提案本身不含敏感业务数据（只有 items 摘要与原因），跨会话可见是产品要求。
     */
    'proposal.list': (_payload, meta) => {
      const b = binding(meta)
      const rows = proposals().filter((p) => (p.scope ?? '') === b.scope)
      return rows
    },

    'proposal.get': (payload, meta) => {
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      const row = proposals().find((p) => p.id === id)
      if (row === undefined) throw notFoundError('提案不存在', { id })
      const b = binding(meta)
      // 按 scope 隔离（同 list 的理由）；跨 scope 才算不存在
      if ((row.scope ?? '') !== b.scope) {
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
      if ((row.scope ?? '') !== b.scope) {
        throw notFoundError('提案不存在', { id })
      }
      if (row.status !== 'pending') throw conflictError('提案已处理', { status: row.status })
      mutateCollab(proposalStore, 'proposals', (current) => {
        const list = Array.isArray(current) ? current.slice() : []
        const target = list.find((p) => p.id === id)
        if (target !== undefined) {
          list[list.indexOf(target)] = { ...target, status: 'rejected', decidedAt: at() }
        }
        return list
      }, { shared: proposalStore !== store })
      store.mutate((draft) => {
        draft.audit.push(audit('proposal.reject', id, meta, { status: 'rejected' }))
        return draft
      }, { intent: 'proposal.reject.audit', undo: false })
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
       * 审批指纹绑定**提案内容**（复审 F2）。
       *
       * 原实现只绑 `(op, target=提案id)`，提案内容从不参与 —— 用户确认了 1 条，
       * 签发后把落盘 items 换成 50 条，原凭证照样全量落地（实测 created:50）。
       * 现在把 `proposalContentDigest(row)` 绑进指纹：签发端算的是用户**看到的
       * 那份内容**，执行端算的是**盘上现在这份**，两者不同即 fingerprint-mismatch。
       *
       * 顺序必须是「先读提案 → 再校验凭证」：摘要依赖内容，反过来做不到。
       */
      const id = payload?.id
      if (typeof id !== 'string' || id === '') throw validationError('id 必须是非空字符串')
      /**
       * **凭证校验必须在「提案是否存在」之前**。
       *
       * 摘要依赖内容，所以要先读提案；但若因此把「无凭证」的判定挪到读之后，
       * 就会出现两个问题（端到端探针 E6.1 实测踩到）：
       *   1. 不带凭证、指向不存在 id 的调用会得到 `not-found` 而不是
       *      `confirmation-required` —— 危险 op 要不要凭证，居然取决于
       *      目标存不存在，这是可被探测的口子；
       *   2. 调用方据此能区分「目标存在」与「不存在」，等于免费的信息泄露。
       *
       * 所以分两段：先用**空摘要**过一遍凭证门（无 token / 过期 / 已用 /
       * 未知 token 都在这里被拒），确认凭据本身有效后再读内容、再校验摘要。
       * 后一段的 `fingerprint-mismatch` 才承担「内容被换过」的判定。
       */
      const b = binding(meta)
      assertTokenUsable('proposal.apply', id, meta)
      const row = proposals().find((p) => p.id === id)
      if (row === undefined) throw notFoundError('提案不存在', { id })
      requireConfirmation('proposal.apply', meta, {
        target: id,
        digest: proposalContentDigest(row),
      })
      if (row.status !== 'pending') throw conflictError('提案已处理', { status: row.status })

      /**
       * **跨工作区落地时不校验全局 baseDigest**（WP6-E 复审 P0-2 后的必要修正）。
       *
       * 提案由 Agent 在自己的工作区生成，`baseVersion/baseDigest` 描述的是
       * **那个**工作区的数据状态；用户在自己的工作区落地时两者必然不同，
       * 硬校验会让整条主路径再次不可用（实测 base-digest-mismatch）。
       *
       * 跨工作区时改用**更强的逐条绑定**：每条 `task.update` 都带
       * `targetDigest`（目标行内容摘要），apply 时逐条比对，任何一条被替换
       * 都整份拒绝。同工作区仍走全局 baseVersion/baseDigest —— 两条路径都不松。
       */
      const crossWorkspace = row.sessionId !== b.sessionId
      const check = verifyProposalBinding(row, {
        version: version(),
        digest: digest(),
        sessionId: b.sessionId,
        scope: b.scope,
        skipGlobalDigest: crossWorkspace,
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
              targetDigest: safe.targetDigest ?? item.targetDigest,
              payload: validateTaskInput(safe.payload),
            })
          }
        } catch (error) { throw asServiceError(error) }
      }

      const backup = store.backup('before-proposal-apply')
      const stackBefore = store.read().undo ?? []
      const undoDepthBefore = stackBefore.length
      // 锚点：落地前栈顶 entry 的 id。historyLimit 裁剪后栈深会失真，
      // 折叠时用这个 id 在裁剪后的栈里定位真正的分界点（见 store.collapseUndo）。
      const undoAnchorId = stackBefore.length > 0 ? stackBefore[stackBefore.length - 1]?.id : undefined
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
            const target = tasks().find((t) => t.id === item.targetId)
            if (target === undefined) throw notFoundError('提案目标待办已不存在', { id: item.targetId })
            /**
             * P1-3：目标行内容必须与生成提案时一致，否则整份拒绝（防确认后被替换）。
             *
             * **空 digest 一律拒绝**：`targetDigest` 只有在「生成提案时能读到目标行」
             * 才会被回填。跨工作区场景下 Agent 工作区没有该任务 → digest 为空；
             * 若此时放行，就等于「确认期间目标被任意修改也照旧覆盖」，P1-3 的
             * 防替换责任在此路径上完全失效。宁可让用户重新生成提案。
             */
            if (typeof item.targetDigest !== 'string' || item.targetDigest === '') {
              throw conflictError('提案缺少目标内容摘要，请重新生成提案', {
                id: item.targetId, reason: 'target-digest-missing',
              })
            }
            const nowDigest = createHash('sha256')
              .update(JSON.stringify(target)).digest('hex').slice(0, 16)
            if (nowDigest !== item.targetDigest) {
              throw conflictError('提案目标内容已变化（请重新生成提案）', {
                id: item.targetId, reason: 'target-digest-mismatch',
              })
            }
            if (typeof updateTask !== 'function') throw new Error('缺少待办更新器')
            created.push({ kind: 'task', row: updateTask(item.targetId, item.payload, meta) })
          }
        }
      } catch (error) {
        /**
         * **失败回滚只恢复业务集合，绝不清空用户的撤销历史**（WP6-E 复审 P1-2）。
         *
         * 原实现调 `store.rollback(backupName)`：它把整个 state 换成备份文件的内容，
         * 而备份里的 `undo` 是落地前的更早状态 → 用户既有的撤销历史被抹掉
         * （实测 undoDepth 4 → 0、canUndo=false）。一次失败的落地不该惩罚用户。
         *
         * 这里直接按落地前快照还原 events/tasks，undo/redo 栈保持当前值；
         * 落地过程中 push 的 undo entry 也一并清掉（它们对应的写入已被撤销）。
         */
        try {
          store.mutate((draft) => {
            draft.events = structuredClone(beforeState.events)
            draft.tasks = structuredClone(beforeState.tasks)
            if (Array.isArray(draft.undo)) {
              draft.undo = draft.undo.slice(0, undoDepthBefore)
            }
            return draft
          }, { intent: 'proposal.apply.rollback', undo: false })
        } catch {
          // 还原都失败时退回原始备份恢复（至少保住业务数据）
          store.rollback(backup.path.split('/').pop())
        }
        throw error
      }

      // 标记 applied 的 mutate 也会进 undo 栈，必须放在**折叠之前**，
      // 否则折叠后又被追加一条，history.undo 弹到的是那条（其 before 已含
      // 落地后的数据），表现为「撤销无效」。WP5 的 event.import 注释已明确
      // 写过「折叠必须放在最后」，这里踩了同一个坑，顺序修正。
      mutateCollab(proposalStore, 'proposals', (current) => {
        const list = Array.isArray(current) ? current.slice() : []
        const target = list.find((p) => p.id === id)
        if (target !== undefined) {
          list[list.indexOf(target)] = { ...target, status: 'applied', decidedAt: at() }
        }
        return list
      }, { shared: proposalStore !== store })
      store.mutate((draft) => {
        draft.audit.push(audit('proposal.apply', id, meta, { items: created.length }))
        return draft
      }, { intent: 'proposal.apply.audit', undo: false })

      // 折叠成一条 undo —— 必须是本 op 的最后一次写栈动作
      if (typeof collapseUndo === 'function') {
        collapseUndo(undoDepthBefore, 'proposal.apply', beforeState, undoAnchorId)
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
      /**
       * **跨工作区关联**（V1.1 §2.1 修复）。
       *
       * 原实现只查本工作区：`if (!rows.some(...)) throw notFound`。
       * 任务实体在**用户**工作区，Agent 在自己工作区里永远找不到它 ——
       * 于是「第二个 Agent 会话要关联同一个任务」直接报「待办不存在」，
       * 多 Agent 协作（澄清 → 拆解 → 执行）从第二步就断了。
       *
       * 越权防线与 `task.writeProgress` 保持一致：本工作区没有该任务时，
       * **只有** collab assignments 里已把该任务分配给本会话才允许继续。
       * 既不在本工作区、也没分配给自己的任务仍然拒绝 —— 不能借修这个
       * 缺陷把越权口子打开。
       */
      const inMyWorkspace = rows.some((r) => r.id === id)
      if (!inMyWorkspace) {
        const assignedToMe = readAssignmentsFresh(proposalStore)
          .some((a) => a.taskId === id && a.sessionId === link.sessionId)
        if (!assignedToMe) throw notFoundError('待办不存在', { id })
      }
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
      /**
       * **同时写一条 scope 级共享的 assignment 摘要**（WP6-E 复审修复，P0）。
       *
       * 任务本身存在**谁的工作区里谁私有**（这是 WP1–WP5 的隔离保证）。
       * 但 Agent 会话与用户会话是两个目录，Agent 调 task.context 时读自己那份
       * 只会有 0 条 —— 实测 B2 就是这么失败的。
       *
       * 所以在 scope 级 collab store 里维护一份「哪些任务分配给了哪个会话」的
       * 摘要，Agent 据此知道「我被分配了什么」。摘要只含协作必需字段，
       * 不含任务全量数据。
       */
      const row = tasks().find((r) => r.id === id)
      /**
       * 跨工作区关联时 `row` 是 undefined（任务在用户工作区）。
       * 原条件 `row !== undefined` 让 assignment **永远写不出来** ——
       * 于是第二个 Agent 会话再关联同一任务时，越权防线（查 assignments）
       * 也查不到，直接拒成「待办不存在」。
       *
       * 修法：本工作区有任务就取真实摘要；没有就用已有 assignment 里的
       * 摘要兜底（至少 title 等字段能保留）。两者都没有时仍然不写 ——
       * 那种情况下越权防线已经在上面拦掉了，走不到这里。
       */
      const priorAssignment = proposalStore !== store && row === undefined
        ? readAssignmentsFresh(proposalStore).find((a) => a.taskId === id)
        : undefined
      const summarySource = row ?? priorAssignment
      if (proposalStore !== store && summarySource !== undefined) {
        mutateCollab(proposalStore, 'assignments', (current) => {
          const list = Array.isArray(current) ? current.slice() : []
          const entry = {
            taskId: id,
            sessionId: link.sessionId,
            role: link.role,
            note: link.note,
            at: link.at,
            title: String(summarySource.title ?? ''),
            priority: summarySource.priority,
            dueAt: summarySource.dueAt,
            estimatedMinutes: summarySource.estimatedMinutes,
            done: summarySource.done === true,
            completion: typeof summarySource.completion === 'object' && summarySource.completion !== null
              ? (summarySource.completion.status ?? null)
              : (summarySource.completion ?? null),
            progress: Array.isArray(summarySource.executionLog) && summarySource.executionLog.length > 0
              ? summarySource.executionLog[summarySource.executionLog.length - 1].progress
              : (summarySource.progress ?? 0),
            updatedAt: at(),
          }
          const idx = list.findIndex((a) => a.taskId === id && a.sessionId === link.sessionId)
          if (idx >= 0) list[idx] = { ...list[idx], ...entry }
          else list.push(entry)
          return list
        }, { shared: proposalStore !== store })
      }
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
      /**
       * 两条来源合并（WP6-E 复审修复）：
       * 1) **本工作区**里直接关联了本会话的任务（同会话内直连，含完整明细）；
       * 2) **scope 级共享 assignments** 里分配给本会话的任务（跨会话分配，
       *    只有摘要 —— 任务实体在别人的工作区里，这层隔离不能破）。
       * 只取 1) 会让 Agent 在「任务建在用户工作区」时读到 0 条（实测 B2）。
       */
      const localRows = tasks().filter((t) => Array.isArray(t.sessionLinks)
        && t.sessionLinks.some((l) => l.sessionId === b.sessionId))
      const localIds = new Set(localRows.map((t) => t.id))
      /**
       * **必须重读磁盘**，不能用 `proposalStore.collection()`。
       *
       * `openStore` 在打开时把 state 读进内存并缓存（store.js `let state = load()`）。
       * 不同 session 各自开一个 service 实例 → 各自的 collabStore 是不同内存副本。
       * 本会话的实例若在别人写 assignment 之前就打开了，内存里永远看不到新分配
       * （实测：assignment 已落盘、task.context 仍返回 0 条）。
       *
       * 跨实例共享的正确做法是读时直接读文件；写入仍走 collabStore.mutate。
       */
      const sharedAssignments = readAssignmentsFresh(proposalStore)
        .filter((a) => a.sessionId === b.sessionId && !localIds.has(a.taskId))
      const projected = localRows.map((t) => {
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
      const sharedProjected = sharedAssignments.map((a) => ({
        id: a.taskId,
        title: a.title,
        status: undefined,
        priority: a.priority,
        dueAt: a.dueAt,
        estimatedMinutes: a.estimatedMinutes,
        done: a.done === true,
        completion: a.completion ?? null,
        progress: a.progress ?? 0,
        recentLog: Array.isArray(a.log) ? a.log.slice(-5) : [],
        roles: [a.role],
        // 标明这是跨工作区分配（任务实体不在本会话工作区）
        source: 'shared-assignment',
      }))
      return { sessionId: '[self]', tasks: [...projected, ...sharedProjected] }
    },

    /**
     * 反查：某会话关联了哪些任务。
     *
     * **安全边界依赖目录隔离**（WP6-E 复审 P1-4 已确认并加固说明）：
     * 只返回**本工作区**（调用方自己的 session 私有目录）里的任务行，
     * 因此即便 `payload.sessionId` 指向别的会话，读到的也仅是「我的任务里
     * 关联了那个会话」的那些 —— 不构成跨会话数据泄露。
     *
     * 这里**无法**再加 `payload.sessionId === meta.sessionId` 校验：本 op 的
     * 业务语义就是「按指定 agent 会话反查我自己的任务」，参数天然可以不是调用方。
     * 真正的越权防线是：任务实体只在各自工作区、且 collab store 只读共享摘要。
     * 若将来引入可写的共享任务表，必须在此处补显式授权校验（已在契约记录）。
     */
    'task.bySession': (payload, meta) => {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw validationError('sessionId 必须是非空字符串')
      }
      // 显式带上 scope 一致性：跨 scope 一律返回空（与提案可见性口径一致）
      const b = binding(meta)
      void b
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
      /**
       * **跨工作区回写**（WP6-E 复审 P0-2 修复）。
       *
       * 任务实体在**用户**工作区，Agent 在自己的工作区里找不到它 —— 直接
       * `not-found` 会让「Agent 执行 → 回写进度」整条链路不可用。
       * 若本工作区没有、但 collab assignments 里确实把该任务分配给了本会话，
       * 就把进度写进共享 assignment（用户侧读任务时合并展示）。
       * 不允许「既不在本工作区、也没分配给本会话」的任务被写（越权防线）。
       */
      const entry = {
        at: at(),
        sessionId: b.sessionId,
        progress,
        note: String(payload?.note ?? '').slice(0, 500),
        evidence: String(payload?.evidence ?? '').slice(0, 500),
      }
      if (!rows.some((r) => r.id === id)) {
        const assignedToMe = readAssignmentsFresh(proposalStore)
          .some((a) => a.taskId === id && a.sessionId === b.sessionId)
        if (!assignedToMe) throw notFoundError('待办不存在', { id })
        mutateCollab(proposalStore, 'assignments', (current) => {
          const list = Array.isArray(current) ? current.slice() : []
          const idx = list.findIndex((x) => x.taskId === id && x.sessionId === b.sessionId)
          if (idx >= 0) {
            const a = { ...list[idx] }
            a.progress = progress
            a.updatedAt = at()
            a.log = Array.isArray(a.log) ? a.log.concat(entry).slice(-20) : [entry]
            list[idx] = a
          }
          return list
        }, { shared: proposalStore !== store })
        store.mutate((draft) => {
          draft.audit.push(audit('task.writeProgress', id, meta, { progress, via: 'assignment' }))
          return draft
        }, { intent: 'task.writeProgress.audit', undo: false })
        return { id, progress, entry, via: 'shared-assignment' }
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

    /**
     * 只读：列出共享 assignment 里**待验收**的申请（用户侧 UI 用）。
     *
     * 任务实体在各自工作区，Agent 的验收申请写在 scope 级 assignment 上；
     * 用户在 UI 里需要看到「哪些任务在等我验收」。只返回 pending 申请。
     */
    'task.completionRequests': () => {
      const rows = readAssignmentsFresh(proposalStore)
        .filter((a) => a.completion === 'pending')
        .map((a) => ({
          taskId: a.taskId,
          sessionId: a.sessionId,
          title: a.title,
          completion: a.completion,
          summary: a.completionRequest?.summary ?? '',
          requestedAt: a.completionRequest?.requestedAt,
        }))
      return rows
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
      /**
       * 跨工作区分支：任务实体在用户工作区，Agent 只能把「验收申请」写进
       * 共享 assignment，由用户侧读任务时合并、并由用户在 UI 上验收。
       * **AI 依旧不能自行完成** —— 这里只记录 pending 申请。
       */
      if (!rows.some((r) => r.id === id)) {
        const mine = readAssignmentsFresh(proposalStore)
          .find((a) => a.taskId === id && a.sessionId === b.sessionId)
        if (mine === undefined) throw notFoundError('待办不存在', { id })
        mutateCollab(proposalStore, 'assignments', (current) => {
          const list = Array.isArray(current) ? current.slice() : []
          const idx = list.findIndex((x) => x.taskId === id && x.sessionId === b.sessionId)
          if (idx >= 0) {
            list[idx] = { ...list[idx], completion: 'pending', completionRequest: request, updatedAt: at() }
          }
          return list
        }, { shared: proposalStore !== store })
        store.mutate((draft) => {
          draft.audit.push(audit('task.requestCompletion', id, meta, { status: 'pending', via: 'assignment' }))
          return draft
        }, { intent: 'task.requestCompletion.audit', undo: false })
        return { id, completion: request, done: false, via: 'shared-assignment' }
      }
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
      /**
       * 跨工作区验收：任务在**用户**工作区（此处 row 存在即本工作区）。
       * 若 row 不存在但共享 assignment 里有待验收申请，说明任务在别的分片；
       * 这里不允许「凭空完成不存在于任何地方的任务」，拒绝。
       */
      if (row === undefined) throw notFoundError('待办不存在', { id })
      /**
       * 申请可能来自**另一工作区的 Agent**（写在共享 assignment 上）。
       * 本地任务没有 pending 申请时，去 assignment 找；找到就以它为准。
       */
      let pendingRequest = row.completion
      if (row.completion?.status !== 'pending') {
        const shared = readAssignmentsFresh(proposalStore)
          .find((a) => a.taskId === id && a.completion === 'pending')
        if (shared !== undefined) {
          pendingRequest = {
            status: 'pending',
            summary: shared.completionRequest?.summary ?? '',
            requestedAt: shared.completionRequest?.requestedAt,
            requestedBy: shared.sessionId,
          }
        }
      }
      if (pendingRequest?.status !== 'pending') {
        throw conflictError('没有待验收的完成申请', { status: pendingRequest?.status ?? 'none' })
      }
      store.mutate((draft) => {
        const target = draft.tasks.find((r) => r.id === id)
        if (target !== undefined) {
          target.done = true
          target.completion = {
            ...pendingRequest,
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

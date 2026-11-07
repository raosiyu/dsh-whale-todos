/**
 * WP5.1 · 提醒投递：Workbench 数据 ↔ Host `ctx.schedule` 的同步层。
 *
 * ## 真实接口来源（一手核实，不是自造）
 *
 * `@deepseek-ai/dsh-schedule` 由 `dsh-web-app/cordis.patch.yml:125-126` 挂载为
 * **id `schedule`**，Service 名为 `schedule`（`lib/index.js:2612` `super(ctx,"schedule")`）。
 * 隔离实例实测（register 后 `inject:['schedule']`）拿到真实对象：
 *
 *   [probe] schedule keys: ctx,name,typertRemote,retention,ready,initialized,chain,runtime,stopping
 *   [probe] has create/catalog/history: function
 *
 * 实测通过的调用（隔离 profile，真实 session）：
 *   create(sessionId, {prompt,title,at}) → {id:'schedule-…', kind:'at', scheduledAt:'…Z'}
 *   catalog()                            → [{id,kind,title,prompt,scheduledAt,sessionId,…}]
 *   update({sessionId,id,expected,…})    → {id, updated:true, record:{…}}
 *   delete({sessionId,id})               → {id, deleted:true}
 *   history({sessionId,id,limit})        → {id, records:[], earlierRecordsUnavailable, retention:{days,records}}
 *
 * 持久化落在 `<DSH_HOME>/storages/schedule.json`，结构：
 *   { unit:{name:"schedule",version:1}, global:null,
 *     tables:{ tasks:{ "<id>": { sessionId, record:{id,kind,title,prompt,scheduledAt},
 *                                status:"active", deliveryHistory:{records:[],…} } } } }
 * 重启后 `catalog()` 仍能读回同一条且 `status:'active'` —— 已实测。
 *
 * ## 投递语义（必须说清楚，不许含糊）
 *
 * dsh-schedule 的投递是 **在原 Session 里发一条后续消息**
 * （`dsh-web-app/cordis.patch.yml` 原文：`delivers each due occurrence as a
 * follow-up in its original Session`）。**不是 macOS 系统通知**：DSH 全仓库
 * 没有任何 `UNUserNotification` / `display notification` / `osascript … notification`
 * 调用。所以本模块对外只能说「提醒已注册为 Host 持久化任务」，不能说
 * 「会弹系统通知」。
 *
 * ## 为什么不用 `workbench-core/src/schedule-adapter.js`
 *
 * 那个文件是 WP3 的**内存模拟**（`tick()` 注释原话：「模拟到点投递：从计划移除，
 * 但保留投递读取能力」），只把记录从 Map 挪进数组，没有任何 Host 写操作、没有持久化、
 * 重启即丢。WP5.1 的 P0 明确禁止「仅用内存 tick() 模拟真实投递」，因此这里是
 * **独立实现**，不复用那个适配器。schedule-adapter 保留原样（它服务
 * `reminder.plan` 的只读预览，UI 提醒条仍在用），但不再被当作投递通道。
 */

/** 提醒标题最大长度（dsh-schedule 硬约束：`MAX_TITLE_LENGTH = 120`）。 */
export const MAX_REMINDER_TITLE = 120

/**
 * 身份标记的**不可见前缀**（U+200B 零宽空格 + U+2060 word joiner）。
 *
 * 为什么加它：原判据只认 prompt 末尾的 `[[wb:…]]`，用户自己在 schedule 里建的
 * 提醒只要正文末尾手写这个字样，就会被认成本插件记录 → 若其 identity 不在
 * 期望集合里就会被**删掉**。实测伪造 `"task:victim-id"` 确实被认领。
 *
 * 加两个不可见字符不能「杜绝」伪造（用户仍可复制粘贴），但让它不可能被
 * **自然打字**产生，把风险从「随口一写就中」降到「刻意构造才行」。
 * 真正的隔离仍靠 sessionId 过滤（见 ownHostRecords）。
 */
export const IDENTITY_MARK_PREFIX = '\u200B\u2060'

/** 完整标记左半。 */
export const IDENTITY_MARK_OPEN = `${IDENTITY_MARK_PREFIX}[[wb:`

/** 提醒正文最大长度。Host 侧对 prompt 只要求非空，这里给一个防御上限避免写入超长文本。 */
export const MAX_REMINDER_PROMPT = 2000

/**
 * 一条提醒的稳定身份。
 *
 * **不能用 `title + scheduledAt`**：改标题不改时间就会漏掉旧记录，导致重复注册。
 * 用「实体类型 + 实体 id + 触发类型」构成身份，时间变化只走 update，不换身份。
 *
 * @param {'task'|'event-start'} kind
 * @param {string} entityId
 * @returns {string}
 */
export function reminderIdentity(kind, entityId, scope = '') {
  /**
   * **scope 必须进身份。**
   *
   * 业务数据是按 scope 分目录隔离的（`host-service.js`：
   * `${dirName}${scopeSuffix}`，注释明写「只作 Map key 而不分目录，会让两个
   * scope 共用同一份文件存储」）。提醒层若无视 scope，两个 scope 下同 id 的
   * 实体就会算出同一个 identity → 后一轮把前一轮的记录 update 掉 →
   * **两个 scope 的提醒互相踩踏，且不报错**。
   *
   * scope 为空时用固定占位 `_`，避免 `''` 与某种 scope 值产生歧义。
   */
  const scopeKey = scope === '' ? '_' : String(scope)
  return `${kind}:${scopeKey}:${String(entityId)}`
}

/**
 * 从一条 task 推出它应有的提醒描述；不应有提醒时返回 null。
 *
 * 规则（与 `taskBucket` / `schedule-adapter` 的判定保持一致）：
 *  - 软删（`deleted === true`）→ 无提醒
 *  - 已完成（`done === true`）→ 无提醒
 *  - `dueAt` 缺失 / 空白 → 无提醒
 *  - `dueAt` 非法（`Date.parse` 失败，或缺少时区后缀）→ 无提醒（**并且要能被上报**）
 *  - 触发时刻已过去 → 无提醒（过期不补注册）
 *
 * @param {object} task
 * @param {number} nowMs
 * @returns {{ ok: true, value: null | { kind: 'task', entityId: string, identity: string, title: string, prompt: string, fireAtMs: number } }
 *          | { ok: false, reason: 'invalid-dueAt' }}
 */
export function reminderForTask(task, nowMs, scope = '') {
  if (task === null || typeof task !== 'object') return { ok: true, value: null }
  if (task.deleted === true) return { ok: true, value: null }
  if (task.done === true) return { ok: true, value: null }

  const dueRaw = task.dueAt
  const blank = dueRaw === undefined || dueRaw === null
    || (typeof dueRaw === 'string' && dueRaw.trim() === '')
  if (blank) return { ok: true, value: null }

  const text = String(dueRaw).trim()
  const ms = Date.parse(text)
  // 与 `validate.js` 的 `isoInstant` 同一条判据：必须带显式时区后缀。
  // Date.parse 对 '2026'、'2026/11/10' 都返回合法毫秒数，宽松到危险。
  if (Number.isNaN(ms) || !/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    return { ok: false, reason: 'invalid-dueAt' }
  }
  if (ms <= nowMs) return { ok: true, value: null }

  const entityId = String(task.id ?? '')
  if (entityId === '') return { ok: true, value: null }

  const title = reminderTitle(task.title, entityId)
  return {
    ok: true,
    value: {
      kind: 'task',
      entityId,
      identity: reminderIdentity('task', entityId, scope),
      title,
      prompt: `待办「${title}」到期了。`,
      fireAtMs: ms,
    },
  }
}

/**
 * 从一条 event 推出它应有的提醒描述。
 *
 * 只有**非全天**且**有明确 start** 的日程才有提醒；全天日程没有时刻，无从提醒。
 *
 * @param {object} event
 * @param {number} nowMs
 * @returns {{ ok: true, value: null | { kind: 'event-start', entityId: string, identity: string, title: string, prompt: string, fireAtMs: number } }
 *          | { ok: false, reason: 'invalid-start' }}
 */
export function reminderForEvent(event, nowMs, scope = '') {
  if (event === null || typeof event !== 'object') return { ok: true, value: null }
  if (event.deletedAt !== undefined && event.deletedAt !== null) return { ok: true, value: null }
  if (event.allDay === true) return { ok: true, value: null }

  const startRaw = event.start
  if (startRaw === undefined || startRaw === null || String(startRaw).trim() === '') {
    return { ok: true, value: null }
  }
  const ms = Date.parse(String(startRaw))
  if (Number.isNaN(ms)) return { ok: false, reason: 'invalid-start' }
  if (ms <= nowMs) return { ok: true, value: null }

  const entityId = String(event.id ?? '')
  if (entityId === '') return { ok: true, value: null }

  const title = reminderTitle(event.title, entityId)
  return {
    ok: true,
    value: {
      kind: 'event-start',
      entityId,
      identity: reminderIdentity('event-start', entityId, scope),
      title,
      prompt: `日程「${title}」开始了。`,
      fireAtMs: ms,
    },
  }
}

/**
 * 生成符合 Host 约束的标题：非空、trim 过、≤120。
 *
 * Host 对 title 的判定是 `invalid_prompt`，而**不允许从 prompt 推导标题**，
 * 所以这里必须自己兜底出一个合法标题，否则创建会整批失败。
 *
 * @param {unknown} raw
 * @param {string} fallbackSeed
 * @returns {string}
 */
export function reminderTitle(raw, fallbackSeed) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const base = text === '' ? `待办 ${fallbackSeed}` : text
  return base.length > MAX_REMINDER_TITLE ? base.slice(0, MAX_REMINDER_TITLE) : base
}

/**
 * 计算「当前期望的提醒集合」与「Host 上已有的提醒」之间的差集。
 *
 * 纯函数，不碰 IO —— 这样差异逻辑可以被单元测试穷举，投递路径只负责执行。
 *
 * @param {Array<{id: string, title: string, prompt: string, scheduledAt: string}>} existing
 *        Host `catalog()` 中属于本插件的记录（已按 identity 归好，见 `identityOfHostRecord`）
 * @param {Map<string, {identity: string, title: string, prompt: string, fireAtMs: number}>} desired
 * @returns {{ toCreate: object[], toUpdate: object[], toDelete: string[], unchanged: string[] }}
 */
export function diffReminders(existing, desired) {
  const toCreate = []
  const toUpdate = []
  const toDelete = []
  const unchanged = []

  const seen = new Set()
  for (const row of existing) {
    const identity = identityOfHostRecord(row)
    if (identity === null) continue
    seen.add(identity)
    const want = desired.get(identity)
    if (want === undefined) {
      toDelete.push(row.id)
      continue
    }
    // 期望触发时刻与 Host 上的一致、且文本没变 → 不动。
    //
    // **比较基准必须是「实际会写进去的那份文本」**：Host 上存的是
    // `encodePrompt(prompt, identity)`（带 `[[wb:…]]` 标记），而 `want.prompt`
    // 是不带标记的原文。直接拿两者比，永远不相等 → 每次 reconcile 都判定
    // 「需要更新」，幂等性彻底失效（实测 R2/R3 恒为 updated:2）。
    const sameTime = Date.parse(String(row.scheduledAt)) === want.fireAtMs
    const sameText = row.title === want.title
      && row.prompt === encodePrompt(want.prompt, want.identity)
    if (sameTime && sameText) {
      unchanged.push(identity)
    } else {
      toUpdate.push({ id: row.id, existing: row, want })
    }
  }

  for (const [identity, want] of desired) {
    if (!seen.has(identity)) toCreate.push(want)
  }

  return { toCreate, toUpdate, toDelete, unchanged }
}

/**
 * 从 Host 记录反推 identity。
 *
 * 做法：我们自己写入的 prompt 里带一个不可见标记 `[[wb:<identity>]]`。
 * 为什么不用 `record.title` 反查：标题会被用户改、会被截断、可能重名，
 * 而提示正文是我们自己生成的、且用户在 UI 上不可见这一行，作为身份载体最稳。
 *
 * 兜底：老记录（本模块上线前写入的、没有标记的）一律视为「非本插件」返回 null，
 * **绝不去删**——宁可留一条孤儿，也不能误删用户自己建的其他提醒。
 *
 * @param {{prompt?: unknown}} row
 * @returns {string | null}
 */
export function identityOfHostRecord(row) {
  if (row === null || typeof row !== 'object') return null
  const prompt = typeof row.prompt === 'string' ? row.prompt : ''
  /**
   * 只认**带不可见前缀**的标记。用户自然写出的 `[[wb:…]]` 不认领。
   * 旧的纯文本标记（本改动前写入的记录）也不再认领 —— 它们会被当作
   * 「非本插件」保留下来，宁可留孤儿，不误删（本项目一贯取舍）。
   */
  const m = /\u200B\u2060\[\[wb:([^\]]+)\]\]\s*$/.exec(prompt)
  return m === null ? null : m[1]
}

/**
 * 从 catalog 条目中挑出纯粹的 `ScheduleRecord`。
 *
 * `ScheduleCatalogEntry = ScheduleRecord & { sessionId, status, lastDelivery? }`，
 * 多出来的三个字段是 catalog 的投影，不属于 record 本身。`update` 的
 * `expected` 要求「完整观察到的 record」，把投影字段混进去会让
 * compare-and-update 的比较基准变脏。
 *
 * @param {object} entry
 * @returns {object}
 */
export function recordOf(entry) {
  if (entry === null || typeof entry !== 'object') return {}
  const { sessionId, status, lastDelivery, ...record } = entry
  return record
}

/**
 * 把 identity 拆回 `{kind, entityId}`。
 *
 * 只认两种 kind。拆不出来返回 null —— 调用方据此把记录当作「非本插件」，
 * 不删不改。
 *
 * @param {string} identity
 * @returns {{ kind: 'task'|'event-start', entityId: string } | null}
 */
export function decodeIdentity(identity) {
  if (typeof identity !== 'string') return null
  // 新格式 `kind:scope:entityId`；兼容旧格式 `kind:entityId`（scope 视为空）
  const m3 = /^(task|event-start):([^:]*):(.+)$/.exec(identity)
  if (m3 !== null) {
    return { kind: m3[1], scope: m3[2] === '_' ? '' : m3[2], entityId: m3[3] }
  }
  const m2 = /^(task|event-start):(.+)$/.exec(identity)
  if (m2 === null) return null
  return { kind: m2[1], scope: '', entityId: m2[2] }
}

/**
 * 把 identity 编码进 prompt。
 * @param {string} prompt
 * @param {string} identity
 * @returns {string}
 */
export function encodePrompt(prompt, identity) {
  const base = typeof prompt === 'string' ? prompt.trim() : ''
  const tag = ` ${IDENTITY_MARK_OPEN}${identity}]]`
  /**
   * **截断只能截正文，绝不能截掉标记。**
   *
   * 原实现 `tagged.slice(0, MAX_REMINDER_PROMPT)` 从头部截断，而身份标记在
   * 末尾 —— 一旦超长，标记必然被切掉，`identityOfHostRecord` 返回 null，
   * 这条记录就变成「永远认不出、也永远删不掉」的孤儿，每轮 reconcile 还会
   * 再建一条，无界增长。
   *
   * 实测（identity 长 2200）：prompt 长度 2000、能识别身份 null、
   * 结尾是 `xxx…` 而不是 `]]`。
   *
   * 现在先给标记留出预算，只截正文。若标记本身就超预算（identity 极长），
   * 保留完整标记并放弃正文上限 —— 宁可 prompt 超长，也不能丢身份。
   */
  const budget = MAX_REMINDER_PROMPT - tag.length
  if (budget <= 0) {
    // 标记自己就超了：优先保身份，正文压到最短
    return tag.trimStart()
  }
  const body = base.length > budget ? base.slice(0, budget) : base
  return `${body}${tag}`
}

/**
 * 创建提醒同步器。
 *
 * @param {{
 *   schedule: {
 *     create: Function, update: Function, delete: Function, catalog: Function,
 *     history?: Function
 *   },
 *   now?: () => number,
 *   logger?: (event: object) => void
 * }} options
 */
export function createReminderSync(options) {
  const schedule = options.schedule
  const now = options.now ?? (() => Date.now())
  const logger = options.logger ?? (() => {})

  /**
   * 由真实数据算出期望集合。
   *
   * @param {{ tasks?: object[], events?: object[] }} data
   * @returns {{ desired: Map<string, object>, problems: Array<{entityId: string, reason: string}> }}
   */
  function desiredFrom(data, scope = '') {
    const desired = new Map()
    const problems = []
    const at = now()

    for (const task of Array.isArray(data?.tasks) ? data.tasks : []) {
      const r = reminderForTask(task, at, scope)
      if (r.ok === false) {
        problems.push({ entityId: String(task?.id ?? ''), reason: r.reason })
        continue
      }
      if (r.value !== null) desired.set(r.value.identity, r.value)
    }
    for (const event of Array.isArray(data?.events) ? data.events : []) {
      const r = reminderForEvent(event, at, scope)
      if (r.ok === false) {
        problems.push({ entityId: String(event?.id ?? ''), reason: r.reason })
        continue
      }
      if (r.value !== null) desired.set(r.value.identity, r.value)
    }
    return { desired, problems }
  }

  /**
   * 读取 Host 上属于**本插件**的提醒。
   *
   * catalog 不可用时**抛错**，不静默降级成空集合 —— 空集合会让 reconcile 认为
   * 「Host 上什么都没有」，于是把所有提醒重建一遍，造成重复注册。
   *
   * @returns {Promise<object[]>}
   */
  async function ownHostRecords(sessionId, scope = '') {
    const all = await schedule.catalog()
    const rows = Array.isArray(all) ? all : []
    /**
     * **必须按 sessionId 过滤。**
     *
     * 真实 `dsh-schedule` 的 `catalog()` 返回**全表所有 session** 的记录
     * （`lib/index.js` 里是 `table("tasks").entries()`，没有 session 过滤）。
     * 原实现只按 `[[wb:…]]` 标记过滤，于是 session-A 会看到 session-B 的记录，
     * 判定「不在期望集合里」→ 去删 B 的记录 → Host 守卫
     * （`current.sessionId !== request.sessionId`）返回 `{deleted:false}`，
     * 而调用方不看返回值，照样 `report.deleted += 1` —— **报告说删了，实际没删**。
     *
     * `reminder.status` 是判断「提醒有没有在工作」的唯一入口，它说谎等于没有观测。
     */
    return rows.filter((row) => {
      if (row.sessionId !== sessionId) return false
      const identity = identityOfHostRecord(row)
      if (identity === null) return false
      /**
       * **只看本 scope 的记录。**
       *
       * 同一 session 下可以有多个 scope（各用独立数据目录），它们的提醒共用
       * 同一份 catalog。若不过滤 scope，projA 对账时会把 projB 的记录判成
       * 「不在期望集合里」→ 删掉 → 两个 scope 互相踩踏。
       *
       * 这里用三段 identity 的 scope 段做过滤：`kind:scope:entityId`。
       */
      const parts = decodeIdentity(identity)
      if (parts === null) return false
      return parts.scope === (scope === '' ? '' : String(scope))
    })
  }

  /**
   * 对齐：把 Host 上的提醒改造成与当前数据一致。
   *
   * 执行顺序刻意是 **create → update → delete**：
   *  - 先 create：新数据的提醒尽早生效；
   *  - 再 update：改时间/改标题；
   *  - 最后 delete：删掉的放最后，避免中途失败时把还需要的提醒先删了。
   *
   * 单条失败不中断整批（继续处理其余），但会被计入 `failed` 上报，
   * 不吞错。
   *
   * @param {string} sessionId
   * @param {{ tasks?: object[], events?: object[] }} data
   * @returns {Promise<object>}
   */
  async function reconcile(sessionId, data, scope = '') {
    const report = {
      sessionId,
      created: 0, updated: 0, deleted: 0, unchanged: 0,
      failed: [],
      problems: [],
      catalogAvailable: true,
    }

    if (typeof sessionId !== 'string' || sessionId === '') {
      report.failed.push({ stage: 'input', reason: 'missing-sessionId' })
      return report
    }

    const { desired, problems } = desiredFrom(data, scope)
    report.problems = problems

    let existing
    try {
      existing = await ownHostRecords(sessionId, scope)
    } catch (error) {
      // 读不到就不能写：不知道现状就写 = 重复注册风险
      report.catalogAvailable = false
      report.failed.push({
        stage: 'catalog',
        reason: String(error?.code ?? error?.message ?? error),
      })
      logger({ kind: 'reminder-sync', event: 'catalog-unavailable', error: String(error?.message ?? error) })
      return report
    }

    const plan = diffReminders(existing, desired)

    for (const want of plan.toCreate) {
      try {
        await schedule.create(sessionId, {
          title: want.title,
          prompt: encodePrompt(want.prompt, want.identity),
          at: new Date(want.fireAtMs).toISOString(),
        })
        report.created += 1
      } catch (error) {
        report.failed.push({
          stage: 'create',
          identity: want.identity,
          reason: String(error?.code ?? error?.message ?? error),
        })
      }
    }

    for (const item of plan.toUpdate) {
      try {
        // Host 的 update 是 **compare-and-update**：`expected` 必须是
        // 「编辑开始时观察到的完整 record」。
        //
        // `ScheduleCatalogEntry = ScheduleRecord & { sessionId, status, lastDelivery? }`
        // （types.d.ts:184）——条目本身**就是** record，没有嵌套 `record` 字段。
        // 隔离实例实测首条：
        //   {"id":"schedule-…","kind":"at","title":"…","prompt":"…",
        //    "scheduledAt":"…Z","sessionId":"session-…", …}
        // 所以这里把 record 字段挑出来传，不把 sessionId/status 混进去
        // （它们是 catalog 的附加投影，不属于 ScheduleRecord）。
        const res = await schedule.update({
          sessionId,
          id: item.id,
          expected: recordOf(item.existing),
          title: item.want.title,
          prompt: encodePrompt(item.want.prompt, item.want.identity),
          change: { kind: 'at', at: new Date(item.want.fireAtMs).toISOString() },
        })
        /**
         * **必须检查返回值**：Host 的 update 是 compare-and-update，
         * 记录已变（`schedule_conflict`）、已结束（`schedule_ended`）或不存在
         * （`schedule_not_found`）时返回 `{updated:false, code}`，**不抛错**。
         * 只看有没有抛异常，就会把「没改成」记成「改成了」。
         */
        if (res !== null && typeof res === 'object' && res.updated === false) {
          report.failed.push({
            stage: 'update',
            identity: item.want.identity,
            reason: String(res.code ?? 'update-not-applied'),
          })
        } else {
          report.updated += 1
        }
      } catch (error) {
        report.failed.push({
          stage: 'update',
          identity: item.want.identity,
          reason: String(error?.code ?? error?.message ?? error),
        })
      }
    }

    for (const id of plan.toDelete) {
      try {
        const res = await schedule.delete({ sessionId, id })
        /**
         * 同上：删除会话不匹配/记录不存在时返回 `{deleted:false}`，不抛错。
         * 不检查返回值就会出现「报告说删了 N 条、实际一条没删」。
         */
        if (res !== null && typeof res === 'object' && res.deleted === false) {
          report.failed.push({
            stage: 'delete',
            id,
            reason: String(res.code ?? 'delete-not-applied'),
          })
        } else {
          report.deleted += 1
        }
      } catch (error) {
        report.failed.push({
          stage: 'delete',
          id,
          reason: String(error?.code ?? error?.message ?? error),
        })
      }
    }

    report.unchanged = plan.unchanged.length
    logger({ kind: 'reminder-sync', event: 'reconcile', report: { ...report, problems: problems.length } })
    return report
  }

  /**
   * 查某条提醒的投递状态（三态，不把「查不到」当「没投递」）。
   *
   * @param {string} sessionId
   * @param {string} id
   * @returns {Promise<{state: 'delivered'|'undelivered'|'unknown', records?: object[], reason?: string}>}
   */
  async function deliveryStateOf(sessionId, id) {
    if (typeof schedule.history !== 'function') {
      return { state: 'unknown', reason: 'backend-without-history' }
    }
    let res
    try {
      res = await schedule.history({ sessionId, id, limit: 20 })
    } catch (error) {
      return { state: 'unknown', reason: String(error?.code ?? error?.message ?? error) }
    }
    if (res === undefined || res === null) return { state: 'unknown', reason: 'empty-result' }
    const records = Array.isArray(res.records) ? res.records : []
    // `earlierRecordsUnavailable` 表示更早的记录已被裁掉，此时「没有 records」
    // 不能推断成「没投递过」。
    if (records.length > 0) return { state: 'delivered', records }
    if (res.earlierRecordsUnavailable === true) {
      return { state: 'unknown', reason: 'history-pruned' }
    }
    return { state: 'undelivered', records: [] }
  }

  return { reconcile, desiredFrom, ownHostRecords, deliveryStateOf }
}

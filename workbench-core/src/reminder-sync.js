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
 * ## 休眠唤醒由 Host 负责，本层**不叠加自建恢复**（WP5.2 实测结论）
 *
 * `dsh-schedule/lib/index.js` 的 `drive()` 每次触发都重新扫描
 * `scheduledAt <= Date.now()`，没有下界检查；`README.md:279` 明写
 * "A later management change, wake, or restart can retry it"。
 *
 * 隔离实例 SIGSTOP/SIGCONT 实测（真机）：
 *   创建 07:17:55Z / 到点 07:18:35Z / 07:17:55Z 立即 SIGSTOP
 *   休眠跨过触发点 50 秒，零投递
 *   07:20:13Z SIGCONT → deliveredAt 07:20:13.040Z（唤醒后 27ms 补投）
 *   status: active → inactive，deliveryHistory 写入 1 条
 *
 * 因此**不再**接入 `reminder-recovery.js` 的 `recover({scenario:'suspend'})`：
 * 那会与 Host 的补投形成两条投递路径，制造重复消息。该模块保留为
 * WP3 的独立只读逻辑，不作为本插件的投递通道。
 *
 * 本层的职责止于「把数据变化同步成 Host 持久化任务」；何时投递、错过后
 * 何时补投，全部由 Host 的定时器与 drive() 决定。
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
   * ## 为什么不再用 `kind:scope:entityId` 拼接（WP5.2-P0）
   *
   * 拼接有两个不可修复的歧义：
   *  1. scope 自身含冒号 → `a::b` 被 `decodeIdentity` 的 `([^:]*)` 截成 `a`；
   *  2. 空 scope 用 `_` 占位 → 真实 scope 就叫 `_` 时与空 scope 撞成同一个身份。
   *
   * 两者都会让「自家记录」解不出正确 scope → `ownershipOf` 判 `suspect` →
   * 每轮 reconcile 都重新 `create`，而 Host 的 `drive()` 按 `record.id`
   * 去重、`at` 任务不 batch，于是**到点重复投递 N 次**。
   *
   * ## 新格式：带版本标识的定长段编码
   *
   *   `wb2.<kind>.<b64url(scope)>.<b64url(entityId)>`
   *
   * - `wb2` 是版本标识，旧 `kind:scope:entityId` 与 `kind:entityId` 可被识别；
   * - base64url 字母表不含 `.`，所以**任意** scope / entityId（含冒号、Unicode、
   *   换行、`]]` 等）都不会破坏分段，且解码后逐字节还原；
   * - 空 scope 编码成空串，不再是占位符，`''` 与 `'_'` 各自有唯一编码。
   *
   * 不可逆风险为零：base64url 是标准可逆编码，仅作用域内使用。
   *
   * @param {'task'|'event-start'} kind
   * @param {string} entityId
   * @param {string} [scope]
   * @returns {string}
   */
  return `${IDENTITY_FORMAT_V2}.${kind}.${b64urlEncode(scope === '' ? '' : String(scope))}.${b64urlEncode(String(entityId))}`
}

/** 新版身份格式的版本前缀。 */
export const IDENTITY_FORMAT_V2 = 'wb2'

/** 合法的提醒实体类型。 */
export const IDENTITY_KINDS = Object.freeze(['task', 'event-start'])

/**
 * 标准 base64url 编码（RFC 4648 §5），无填充。
 *
 * 字母表 `A-Za-z0-9-_` 不含 `.`，这正是它能安全用作分段分隔的理由。
 *
 * @param {string} text
 * @returns {string}
 */
function b64urlEncode(text) {
  return Buffer.from(String(text), 'utf8').toString('base64url')
}

/**
 * base64url 解码；非法输入抛错由调用方兜住。
 * @param {string} text
 * @returns {string}
 */
function b64urlDecode(text) {
  return Buffer.from(String(text), 'base64url').toString('utf8')
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
  const toDeleteIdentity = new Map()
  const unchanged = []

  const seen = new Set()
  for (const row of existing) {
    const identity = identityOfHostRecord(row)
    if (identity === null) continue
    seen.add(identity)
    const want = desired.get(identity)
    if (want === undefined) {
      toDelete.push(row.id)
      toDeleteIdentity.set(row.id, identity)
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

  return { toCreate, toUpdate, toDelete, toDeleteIdentity, unchanged }
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
 * 判断一条 Host 记录「是不是本插件建的」，并给出**可信度分级**。
 *
 * ## 为什么不能只看标记
 *
 * 标记（哪怕带不可见前缀）**只是 prompt 文本的一部分**，而 `prompt` 是
 * 用户完全可控的字段 —— 任何人都能把它写成带标记的样子。把「有标记」
 * 当成「可信认证」是错的：标记能被复制、能被构造，它不是凭证。
 *
 * Host 的记录 schema 是 `.strict()` 的（`dsh-schedule` 的 zod 校验），
 * **不接受任何自定义 metadata 字段**，所以拿不到真正的结构化认证。
 *
 * ## 因此采用「分级 + 保守删除」
 *
 * - `owned`：标记存在**且**解出的 identity 与本次 reconcile 的
 *   (kind, scope) 自洽。只有这一类允许被删除。
 * - `foreign`：没有标记。不是我们的，**永不碰**。
 * - `suspect`：有标记但解不出、或与本次 scope/kind 不自洽（用户手写、
 *   或别的 scope 的记录）。**保留**，只在报告里列出，交给上层判断。
 *
 * 原则：宁可留孤儿，也不误删用户的东西。
 *
 * @param {object} row
 * @param {{ scope?: string }} [context]
 * @returns {{ level: 'owned'|'foreign'|'suspect', identity: string|null, reason?: string }}
 */
export function ownershipOf(row, context = {}) {
  if (row === null || typeof row !== 'object') {
    return { level: 'foreign', identity: null, reason: 'not-an-object' }
  }
  const identity = identityOfHostRecord(row)
  if (identity === null) {
    return { level: 'foreign', identity: null, reason: 'no-mark' }
  }
  const parts = decodeIdentity(identity)
  if (parts === null) {
    // 有标记但格式不对：可能是用户照着写的，也可能格式演进过 —— 不确定就保留
    return { level: 'suspect', identity, reason: 'undecodable-identity' }
  }
  /**
   * v1 旧格式本身有损（含冒号 scope 已写坏、`_` 占位与真实 scope `_` 撞车）。
   * 解出来的 scope 不可全信 → 一律 `suspect`，走保守路径。
   *
   * 为什么是 `suspect` 而不是直接 `foreign`：若是我们自己早先写的旧记录，
   * 判 foreign 会让它永远清不掉（孤儿）；判 suspect 至少能被上报、被人工处置，
   * 同时**不会**被当作 owned 去删。
   */
  if (parts.legacyAmbiguous === true) {
    return { level: 'suspect', identity, reason: 'legacy-identity-ambiguous' }
  }
  if (context.scope !== undefined) {
    const wantScope = context.scope === '' ? '' : String(context.scope)
    if (parts.scope !== wantScope) {
      return { level: 'suspect', identity, reason: 'scope-mismatch' }
    }
  }
  if (context.kind !== undefined && parts.kind !== context.kind) {
    return { level: 'suspect', identity, reason: 'kind-mismatch' }
  }
  return { level: 'owned', identity }
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
  if (typeof identity !== 'string' || identity === '') return null

  /**
   * ## v2：无歧义，直接解
   *
   * `wb2.<kind>.<b64url(scope)>.<b64url(entityId)>`
   *
   * 段数固定为 4，base64url 不含 `.`，所以 split('.') 不会切错。
   */
  if (identity.startsWith(`${IDENTITY_FORMAT_V2}.`)) {
    const parts = identity.split('.')
    if (parts.length !== 4) return null
    const [, kind, scopeB64, entityB64] = parts
    if (!IDENTITY_KINDS.includes(kind)) return null
    try {
      return { kind, scope: b64urlDecode(scopeB64), entityId: b64urlDecode(entityB64) }
    } catch {
      // 非法 base64 → 当作认不出的旧记录，交给调用方按 suspect 保留
      return null
    }
  }

  /**
   * ## v1：有损格式，只能尽力而为
   *
   * 存在两种历史写法，且**本身就有歧义**：
   *   - 三段：`kind:scope:entityId`（空 scope 写作 `_`）
   *   - 两段：`kind:entityId`（更早，无 scope）
   *
   * `a::b` 这类含冒号 scope 在三段格式里**已经写坏**（存进去的字符串本身
   * 丢失了边界），任何解码都无法还原原 scope。因此这里只做**保守解码**：
   * 能确定就返回，不能确定返回 null，由 `ownershipOf` 判 `suspect` 保留，
   * 绝不因为解错而误删或误判 owned。
   *
   * 空 scope 的 `_` 占位与真实 scope `_` 无法区分 —— 这是 v1 的固有缺陷，
   * 归类为 `suspect` 是安全侧：宁可重建一条新格式记录，也不误删用户数据。
   */
  const m3 = /^(task|event-start):([^:]*):(.+)$/.exec(identity)
  if (m3 !== null) {
    const scopeRaw = m3[2]
    const rest = m3[3]
    /**
     * `kind:A:B` 同时可能是「scope=A, id=B」与「无 scope, id=A:B」两种写法，
     * 单看字符串**无法判定**是哪种 —— 这是 v1 的固有歧义。
     *
     * 唯一可判定为**无歧义**的情形：原样是 `kind:<非空且非'_'的scope>:<不含冒号的id>`
     * 且该 scope 不是空占位。除此之外一律标记 `legacyAmbiguous`，
     * 走 `suspect` 保守路径（保留、不删、不当作 owned）。
     */
    const idLooksAtomic = !rest.includes(':')
    const scopeLooksReal = scopeRaw !== '' && scopeRaw !== '_'
    if (idLooksAtomic && scopeLooksReal) {
      return { kind: m3[1], scope: scopeRaw, entityId: rest }
    }
    return {
      kind: m3[1],
      scope: scopeRaw === '_' ? '' : scopeRaw,
      entityId: rest,
      legacyAmbiguous: true,
    }
  }
  const m2 = /^(task|event-start):(.+)$/.exec(identity)
  if (m2 === null) return null
  // 两段格式：entityId 自身可能含冒号，无法判断原始边界 → 标记歧义
  return { kind: m2[1], scope: '', entityId: m2[2], legacyAmbiguous: true }
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
   * 可选的持久化钩子：让白名单跨进程存活。
   *
   * `options.ownership = { load(): string[], save(ids: string[]): void }`
   *
   * 不持久化的后果：重启后白名单为空 → **所有旧提醒都无法删除** →
   * 数据一致了（不误删）但永远清不掉，孤儿只增不减。所以生产路径必须传它；
   * 测试与纯内存场景可以不传（退化为进程内白名单）。
   */
  /**
   * 可能按 (sessionId, scope) 取存储：`options.ownershipFor(sessionId, scope)`
   * 返回 `{ load(), save(ids) }` 或 null。也接受单个 `options.ownership`。
   *
   * 为什么不放在构造时固定一份：白名单是**每个 session × scope 独立**的，
   * 混在一起会让 A 的创建记录被 B 用来做删除授权。
   */
  const ownershipFor = typeof options.ownershipFor === 'function'
    ? options.ownershipFor
    : (options.ownership !== undefined && options.ownership !== null
      ? () => options.ownership
      : () => null)

  /** 当前作用域的白名单（identity → 存储句柄），按需装载。 */
  const ownershipCache = new Map()

  const ownershipOfScope = (sessionId, scope) => {
    const key = `${sessionId}\u0000${scope}`
    if (ownershipCache.has(key)) return ownershipCache.get(key)
    let store = null
    try {
      store = ownershipFor(sessionId, scope)
    } catch (error) {
      logger({ kind: 'reminder-sync', event: 'ownership-resolve-failed', error: String(error?.message ?? error) })
      store = null
    }
    const entry = {
      store,
      ids: new Set(),
      loaded: false,
      flush() {
        if (store === null || typeof store.save !== 'function') return
        try {
          store.save([...entry.ids])
        } catch (error) {
          logger({ kind: 'reminder-sync', event: 'ownership-save-failed', error: String(error?.message ?? error) })
        }
      },
    }
    ownershipCache.set(key, entry)
    return entry
  }

  const loadOwnership = (entry) => {
    if (entry.loaded) return entry.ids
    entry.loaded = true
    if (entry.store !== null && typeof entry.store.load === 'function') {
      try {
        const loaded = entry.store.load()
        if (Array.isArray(loaded)) {
          for (const id of loaded) {
            if (typeof id === 'string' && id !== '') entry.ids.add(id)
          }
        }
      } catch (error) {
        // 读失败 → 空集 → 本轮少删。绝不因此去删。
        logger({ kind: 'reminder-sync', event: 'ownership-load-failed', error: String(error?.message ?? error) })
      }
    }
    return entry.ids
  }

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
  async function ownHostRecords(sessionId, scope = '', report = null) {
    const all = await schedule.catalog()
    const rows = Array.isArray(all) ? all : []
    /**
     * 只把 `owned`（明确属于本插件且与本次 scope 自洽）的行交给差异计算。
     *
     * `suspect`（有标记但对不上）**不参与任何删除决策** —— 它们可能是
     * 用户手写的、也可能是别的 scope 的。`foreign`（无标记）永远不碰。
     * 这样「身份标记」只承担识别职责，不承担认证职责。
     */
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
      const own = ownershipOf(row, { scope })
      if (own.level === 'owned') return true
      /**
       * **不静默丢弃**（审查 WP5.2 怀疑点 8）。
       *
       * `suspect`（有标记但对不上）与 `foreign`（无标记）都被安全地
       * 排除在删除决策之外，但如果一个字都不报，用户/上层就无从知道
       * 「有一批记录被刻意保留了」。这属于可观测性缺口。
       * 这里只**记录**，绝不改变「不删」的处置。
       */
      if (report !== null && Array.isArray(report.observed)) {
        report.observed.push({
          id: row.id,
          level: own.level,
          identity: own.identity,
          reason: own.reason ?? null,
        })
      }
      return false
    })
  }

  /**
   * 收集「可安全迁移的 v1 旧格式记录」（WP5.2-P0 要求 3）。
   *
   * ## 为什么要单独一条通道
   *
   * v1 的 `kind:scope:entityId` 在 scope 含冒号时**已经写坏**，`decodeIdentity`
   * 只能标 `legacyAmbiguous` 并判 `suspect`。而 `ownHostRecords` 只返回 `owned`，
   * 所以这些旧记录永远进不了差异计算 —— 结果是：
   *
   *   旧记录（v1）留在 Host + 本轮又建一条新记录（v2）
   *   → 到点两条都 due → **仍然重复投递**
   *
   * 因此必须有一条受控的迁移通道把它们清掉。
   *
   * ## 安全边界（严格）
   *
   * 只收集同时满足以下条件的记录，缺一不可：
   *  1. 标记能被 `identityOfHostRecord` 解出（是我们写的格式）；
   *  2. `decodeIdentity` 标了 `legacyAmbiguous`（确实是 v1 旧格式）；
   *  3. **sessionId 与本次一致**（不碰别人的）；
   *  4. 解出的 kind 是合法类型。
   *
   * 即便满足，**也不在这里删** —— 交由 `reconcile` 在确认「v2 新记录已存在」
   * 之后才删，见下方 `legacyToRemove` 逻辑。找不到归属的一律保留。
   *
   * @returns {Promise<Array<{id: string, identity: string}>>}
   */
  async function legacyHostRecords(sessionId, scope = '') {
    const all = await schedule.catalog()
    const rows = Array.isArray(all) ? all : []
    const out = []
    for (const row of rows) {
      if (row.sessionId !== sessionId) continue
      const identity = identityOfHostRecord(row)
      if (identity === null) continue
      const parts = decodeIdentity(identity)
      if (parts === null || parts.legacyAmbiguous !== true) continue
      if (!IDENTITY_KINDS.includes(parts.kind)) continue
      /**
       * v1 解出的 scope 不可信（正是它坏了）。这里不按 scope 精确匹配，
       * 只保留「可能与本 scope 相关」的记录 —— 判定交给后面的
       * 「同名实体在新格式里确实已存在」这一步，那才是真正的安全闸门。
       */
      out.push({ id: row.id, identity, decoded: parts })
    }
    void scope
    return out
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
      kept: [],
      observed: [],
      legacyMigrated: 0,
      legacyKept: [],
      failed: [],
      problems: [],
      catalogAvailable: true,
    }

    if (typeof sessionId !== 'string' || sessionId === '') {
      report.failed.push({ stage: 'input', reason: 'missing-sessionId' })
      return report
    }

    const { desired, problems } = desiredFrom(data, scope)
    const ownership = ownershipOfScope(sessionId, scope)
    const createdIdentities = loadOwnership(ownership)
    report.problems = problems

    let existing
    try {
      existing = await ownHostRecords(sessionId, scope, report)
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
        // 登记「这条是我建的」，删除时以它为准
        createdIdentities.add(want.identity)
        ownership.flush()
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
      /**
       * **删除前必须确认「这条确实是本同步器创建的」。**
       *
       * 只看标记是不够的：标记在 prompt 里，用户可复制。白名单里没有记录，
       * 说明我们从未创建过它 —— 无论标记长得多像，都**不删**。
       * 宁可留一条孤儿，让用户自己去 schedule 里清理，也不冒误删的风险。
       */
      const target = plan.toDeleteIdentity.get(id)
      if (target === undefined || !createdIdentities.has(target)) {
        report.kept.push({
          id,
          identity: target ?? null,
          reason: target === undefined ? 'unknown-identity' : 'never-created-by-us',
        })
        continue
      }
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
          createdIdentities.delete(target)
          ownership.flush()
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

    /**
     * ---------------------------------------------------------------
     * v1 → v2 受控迁移（WP5.2-P0 要求 3）
     * ---------------------------------------------------------------
     *
     * 目的：清掉「已写坏的 v1 旧记录」，否则它和本轮新建的 v2 记录会同时
     * 到点各投递一次，等于 P0 换了个形式复发。
     *
     * **三道闸门，缺一不可**：
     *  1. 旧记录必须能被识别为我们写的 v1 格式（`legacyHostRecords` 已筛）；
     *  2. 同一 (kind, entityId) 的 **v2 新记录必须已经存在于 Host 上**
     *     —— 先建后删，任何时刻都不存在「删了还没建好」的空窗；
     *  3. 删除走的是 `schedule.delete({sessionId, id})`，Host 侧 sessionId
     *     不匹配会返回 `{deleted:false}`，我们检查返回值，不计假成功。
     *
     * 不满足 2 的一律**保留**并记入 `report.legacyKept`：宁可留旧记录，
     * 也不在没有替代品时删掉它（那会让提醒彻底消失）。
     */
    report.legacyMigrated = 0
    report.legacyKept = []
    try {
      const legacy = await legacyHostRecords(sessionId, scope)
      if (legacy.length > 0) {
        // 当前 Host 上现存的 v2 身份集合（用于闸门 2）
        const liveV2 = new Set()
        for (const row of await schedule.catalog()) {
          if (row.sessionId !== sessionId) continue
          const idt = identityOfHostRecord(row)
          if (idt === null) continue
          if (idt.startsWith(`${IDENTITY_FORMAT_V2}.`)) liveV2.add(idt)
        }
        for (const oldRow of legacy) {
          /**
           * **含冒号的 v1 记录无法可靠还原 entityId**：
           *
           *   `task:a::b:t1` → { scope:'a', entityId:':b:t1' }   ← 边界已丢
           *
           * 也就是说「这条旧记录对应哪个实体」在字符串层面**已经不可知**。
           * 拿这个错位的 entityId 去算 v2 身份，只会得到一个对不上的 key，
           * 于是永远匹配不到替代品。
           *
           * 更危险的是：如果我们换个宽松闸门（比如「本 scope 已有 v2 记录
           * 就删旧记录」），就可能删掉一条其实对应**另一个实体**的旧记录 ——
           * 那是误删，用户那条提醒会真的消失。
           *
           * 所以：**不删**。统一记入 `legacyKept` 上报，交人工/后续工具处置。
           * 同时新记录走 v2 身份，不会因为旧记录存在而重复创建
           * （这正是本次 P0 修复的核心）。
           */
          const wantV2 = reminderIdentity(oldRow.decoded.kind, oldRow.decoded.entityId, scope)
          if (!liveV2.has(wantV2)) {
            report.legacyKept.push({
              id: oldRow.id,
              identity: oldRow.identity,
              reason: oldRow.decoded.legacyAmbiguous === true && oldRow.identity.includes('::')
                ? 'v1-boundary-lost'
                : 'no-v2-replacement',
            })
            continue
          }
          try {
            const res = await schedule.delete({ sessionId, id: oldRow.id })
            if (res !== null && typeof res === 'object' && res.deleted === false) {
              report.legacyKept.push({ id: oldRow.id, identity: oldRow.identity, reason: String(res.code ?? 'delete-not-applied') })
            } else {
              report.legacyMigrated += 1
            }
          } catch (error) {
            report.legacyKept.push({ id: oldRow.id, identity: oldRow.identity, reason: String(error?.code ?? error?.message ?? error) })
          }
        }
      }
    } catch (error) {
      // 迁移失败不影响主流程，但要可见
      report.legacyKept.push({ id: null, identity: null, reason: `legacy-scan-failed: ${String(error?.message ?? error)}` })
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

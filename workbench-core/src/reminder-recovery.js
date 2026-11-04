/**
 * 提醒恢复（restart / suspend / exit）——一套显式的恢复语义。
 *
 * ## 为什么需要它
 *
 * `ctx.schedule` 负责「准时投递」，但它不负责「我错过了怎么办」。真实故障形态有三种：
 *
 * 1. **重启（restart）**：进程退出再起来。内存里的计划全没了，必须从持久化状态重建。
 * 2. **休眠（suspend）**：进程在，但时钟停了很久；醒来后一批提醒已过期。
 * 3. **退出（exit）**：用户在提醒到点前主动关掉应用。
 *
 * ## 语义（明确写死不模糊）
 *
 * - **过期未投递的提醒：不补发**（避免醒来被 20 条历史提醒轰炸）。
 *   只记录一条 `missed` 计数，供 UI 展示「有 N 条提醒在离线期间错过」。
 * - **仍在未来的提醒：恢复**（重新落到 schedule）。
 * - **重复事件的后续发生：照常建立**（未来实例不受影响）。
 * - **恢复过程幂等**：同一状态重复恢复不产生重复提醒（靠 reminderKey）。
 *
 * 这三条是产品决策，不是技术顺带；写进测试锁定。
 */

import { reminderKeyOf } from './schedule-adapter.js'

/** 恢复结果。 */
export const RECOVERY_SCENARIOS = Object.freeze(['restart', 'suspend', 'exit'])

/**
 * @param {{
 *   adapter: ReturnType<import('./schedule-adapter.js').createScheduleAdapter>,
 *   now?: () => number,
 *   graceMs?: number,
 * }} options
 */
export function createReminderRecovery(options) {
  const adapter = options.adapter
  const now = options.now ?? (() => Date.now())
  /**
   * 宽限期：到期后仍在这个窗口内的提醒视为「还能补投」（比如刚睡醒 30 秒内）。
   * 超过宽限期的一律按「错过」处理，不补发。
   */
  const graceMs = options.graceMs ?? 60 * 1000

  return {
    /**
     * 执行恢复。
     *
     * @param {Array<{reminderKey: string, fireAtMs: number, title: string, prompt: string}>} plans
     *   从持久化状态重新编译出的「应存在的提醒」
     * @param {{ scenario: 'restart'|'suspend'|'exit', atMs?: number }} input
     * @returns {Promise<{
     *   scenario: string,
     *   restored: string[],
     *   missed: string[],
     *   skippedPast: number,
     *   removed: string[],
     * }>}
     */
    async recover(plans, input) {
      const scenario = input.scenario
      if (!RECOVERY_SCENARIOS.includes(scenario)) {
        throw new Error(`未知恢复场景：${scenario}`)
      }
      const atMs = input.atMs ?? now()

      /**
       * 先读宿主投递历史（能读到才用）。
       *
       * 宿主「投递即出队」，所以一条已投递的提醒在宿主侧表现为"不存在"；
       * 如果只看时间，宽限期内的重启会把它当成"缺失"重新注册 → 用户被重投。
       * 这里用 history 里出现过的 key 作为「已投递」证据，直接跳过。
       */
      let deliveredKeys = new Set()
      let historyAvailable = false
      try {
        const hist = await adapter.history()
        if (Array.isArray(hist) && hist.length >= 0) {
          historyAvailable = true
          deliveredKeys = new Set(hist.map((h) => h.key).filter((k) => typeof k === 'string' && k !== ''))
        }
      } catch {
        historyAvailable = false
      }

      const future = []
      const missed = []
      const alreadyDelivered = []
      for (const plan of plans) {
        if (historyAvailable && deliveredKeys.has(plan.reminderKey)) {
          // 已投递过：不重建，也不计入 missed（它没被"错过"）
          alreadyDelivered.push(plan.reminderKey)
          continue
        }
        if (plan.fireAtMs > atMs) {
          future.push(plan)
        } else if (atMs - plan.fireAtMs <= graceMs) {
          /**
           * 宽限期内补建，但**把触发时刻钳到 atMs 之后**。
           * 否则会把一个过去时刻交给宿主，语义上等于"立即补投"，
           * 而本包的承诺是不补投历史提醒。
           */
          future.push({ ...plan, fireAtMs: Math.max(plan.fireAtMs, atMs + 1000) })
        } else {
          missed.push(plan)
        }
      }

      // 幂等对账：把当前后端状态对齐到「未来应有的提醒」
      const res = await adapter.reconcile(future)

      return {
        scenario,
        restored: [...res.created, ...res.updated],
        missed: missed.map((p) => p.reminderKey),
        alreadyDelivered,
        skippedPast: missed.length,
        removed: res.removed,
        historyAvailable,
      }
    },

    /**
     * 计算「错过摘要」，供 UI 展示。
     * @param {Array<{reminderKey: string, fireAtMs: number, title: string}>} missedPlans
     */
    summarizeMissed(missedPlans) {
      if (missedPlans.length === 0) return '没有错过的提醒'
      const titles = missedPlans.slice(0, 3).map((p) => p.title).join('、')
      const more = missedPlans.length > 3 ? ` 等 ${missedPlans.length} 条` : ''
      return `离线期间错过 ${missedPlans.length} 条提醒：${titles}${more}`
    },
  }
}

/**
 * 从「已存事件 + 任务」重建提醒计划（重启后调用）。
 *
 * @param {{
 *   adapter: Object, events: Array<object>, tasks?: Array<object>,
 *   now?: () => number, windowDays?: number, leadMinutes?: number,
 * }} input
 */
export function rebuildPlans(input) {
  const now = input.now ?? (() => Date.now())
  const windowDays = input.windowDays ?? 30
  /**
   * 回溯期：恢复时必须能看见「刚刚过去」的提醒，否则它们会被窗口直接裁掉，
   * 用户永远看不到「错过了 N 条」的提示。默认回溯 1 天。
   */
  const lookbackDays = input.lookbackDays ?? 1
  const base = now()
  const window = {
    windowStart: base - lookbackDays * 86400000,
    windowEnd: base + windowDays * 86400000,
    monthEndPolicy: input.monthEndPolicy ?? 'rfc',
  }
  const eventPlans = input.adapter.planForEvents(input.events, {
    ...window,
    leadMinutes: input.leadMinutes,
  })
  const taskPlans = input.adapter.planForTasks(input.tasks ?? [], {
    leadMinutes: input.leadMinutes,
  })
  return [...eventPlans, ...taskPlans]
}

export { reminderKeyOf }

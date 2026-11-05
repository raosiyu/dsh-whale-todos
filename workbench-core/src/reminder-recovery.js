/**
 * 提醒恢复（restart / suspend / exit）——一套显式的恢复语义。
 *
 * ## 为什么需要它
 *
 * `ctx.schedule` 负责「准时投递」，但它不负责「我错过了怎么办」。真实故障形态三种：
 *
 * 1. **重启（restart）**：进程退出再起来。内存里的计划全没了，必须从持久化状态重建。
 * 2. **休眠（suspend）**：进程在，但时钟停了很久；醒来后一批提醒已过期。
 * 3. **退出（exit）**：用户在提醒到点前主动关掉应用。
 *
 * ## 语义（写死不模糊）
 *
 * - **已投递过的不重建**：查宿主 `history({sessionId, id, limit})`，有回执即跳过。
 * - **读不到历史 → UNKNOWN**：不谎报「没投递过」，也不据此删任何东西。
 * - **过期较久的不补发**：记 `missed` 并给摘要，避免醒来被 N 条历史提醒轰炸。
 * - **宽限期内补建的，触发时刻钳到未来**：绝不把过去时刻交给宿主。
 * - **恢复过程幂等**：靠 `reminderKey`。
 * - **宿主读不到时只建不删**：`reconcile` 会返回 `degraded: true`。
 *
 * ## scope 纪律
 *
 * 恢复只对**本批次负责的范围**做增删。不给 scope 时保持全量语义（向后兼容），
 * 但调用方应显式传 scope，避免「只恢复事件把任务提醒删光」。
 */

import { reminderKeyOf } from './schedule-adapter.js'

/** 恢复场景。 */
export const RECOVERY_SCENARIOS = Object.freeze(['restart', 'suspend', 'exit'])

/** 投递状态三态：确认投递 / 确认未投递 / 未知。 */
export const DELIVERY_STATE = Object.freeze({
  DELIVERED: 'delivered',
  NOT_DELIVERED: 'not-delivered',
  UNKNOWN: 'unknown',
})

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
   * 宽限期：到期后仍在这个窗口内的提醒视为「还能补投」（如刚睡醒 30 秒内）。
   * 超过宽限期的一律按「错过」处理，不补发。
   */
  const graceMs = options.graceMs ?? 60 * 1000

  /**
   * 查某条提醒的投递状态。**显式三态**，不把「查不到」当成「没投递」。
   * @returns {Promise<{ state: string, records?: object[], reason?: string }>}
   */
  const deliveryStateOf = async (reminderKey) => {
    if (typeof adapter.historyFor !== 'function') {
      return { state: DELIVERY_STATE.UNKNOWN, reason: 'backend-without-history' }
    }
    let res
    try {
      res = await adapter.historyFor(reminderKey)
    } catch (error) {
      return { state: DELIVERY_STATE.UNKNOWN, reason: String(error?.code ?? error?.message ?? error) }
    }
    if (res === undefined || res === null) {
      return { state: DELIVERY_STATE.UNKNOWN, reason: 'empty-result' }
    }
    if (res.status === 'unavailable') {
      return { state: DELIVERY_STATE.UNKNOWN, reason: 'history-unavailable' }
    }
    const records = Array.isArray(res.records) ? res.records : []
    return {
      state: records.length > 0 ? DELIVERY_STATE.DELIVERED : DELIVERY_STATE.NOT_DELIVERED,
      records,
    }
  }

  return {
    /** 单条投递状态（对外也暴露，供 UI 展示）。 */
    deliveryStateOf,

    /**
     * 执行恢复。
     *
     * @param {Array<{reminderKey: string, fireAtMs: number, title: string, prompt: string}>} plans
     * @param {{ scenario: 'restart'|'suspend'|'exit', atMs?: number, scope?: string }} input
     */
    async recover(plans, input) {
      const scenario = input.scenario
      if (!RECOVERY_SCENARIOS.includes(scenario)) {
        throw new Error(`未知恢复场景：${scenario}`)
      }
      const atMs = input.atMs ?? now()

      const future = []
      const missed = []
      const alreadyDelivered = []
      const unknown = []

      for (const plan of plans) {
        const delivery = await deliveryStateOf(plan.reminderKey)

        if (delivery.state === DELIVERY_STATE.DELIVERED) {
          // 已投递：不重建，也不算「错过」
          alreadyDelivered.push(plan.reminderKey)
          continue
        }
        if (delivery.state === DELIVERY_STATE.UNKNOWN) {
          // 投递状态未知：**不删不建**，只记录。宁可留着，不可误删误建。
          unknown.push({ reminderKey: plan.reminderKey, reason: delivery.reason })
          continue
        }

        if (plan.fireAtMs > atMs) {
          future.push(plan)
        } else if (atMs - plan.fireAtMs <= graceMs) {
          // 宽限期内补建；触发时刻**钳到 now 之后**，绝不把过去时刻交给宿主
          future.push({ ...plan, fireAtMs: Math.max(plan.fireAtMs, atMs + 1000) })
        } else {
          missed.push(plan)
        }
      }

      // scope 必须透传：只恢复 events 时不得删掉 tasks 的提醒
      const res = await adapter.reconcile(future, { scope: input.scope })

      return {
        scenario,
        restored: [...res.created, ...res.updated],
        missed: missed.map((p) => p.reminderKey),
        alreadyDelivered,
        unknown,
        skippedPast: missed.length,
        removed: res.removed,
        failed: res.failed ?? [],
        degraded: res.degraded === true,
        historyAvailable: unknown.length === 0,
      }
    },

    /** 错过摘要，供 UI 展示。 */
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
 *   now?: () => number, windowDays?: number, lookbackDays?: number,
 *   leadMinutes?: number, monthEndPolicy?: string,
 * }} input
 * @returns {{ plans: Array, skipped: Array }}
 *   **普通对象**：`skipped` 不会再随 spread / JSON 静默丢失。
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
  const eventResult = input.adapter.planForEvents(input.events, {
    ...window,
    leadMinutes: input.leadMinutes,
  })
  const taskResult = input.adapter.planForTasks(input.tasks ?? [], {
    leadMinutes: input.leadMinutes,
  })
  return {
    plans: [...eventResult.plans, ...taskResult.plans],
    skipped: [...eventResult.skipped, ...taskResult.skipped],
  }
}

export { reminderKeyOf }

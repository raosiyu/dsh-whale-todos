/**
 * workbench-core 公共入口。
 *
 * 只导出稳定接口；内部实现（store 细节、repo 私有函数）不外泄，
 * 便于后续替换存储后端而不破坏调用方。
 */

export {
  ERROR_CODES,
  WorkbenchError,
  isWorkbenchError,
  validationError,
  notFoundError,
  conflictError,
  confirmationRequired,
  unsupportedError,
} from './errors.js'

export {
  isPlainObject,
  isNonEmptyString,
  validateObject,
  optional,
  string,
  nonEmptyString,
  boolean,
  number,
  oneOf,
  arrayOf,
  isoInstant,
  isoDate,
  ianaTimeZone,
} from './validate.js'

export {
  WALL_PATTERN,
  zonedParts,
  offsetMsAt,
  wallToUtcGuess,
  wallToInstant,
  instantToWall,
  addDaysToDate,
  dateToUtcMs,
  daysBetween,
  weekdayOf,
  WEEKDAY_INDEX,
} from './time.js'

export {
  EVENT_SOURCES,
  EVENT_STATUSES,
  IMPORTANCE_LEVELS,
  RRULE_FREQUENCIES,
  WEEKDAYS,
  validateRecurrence,
  validateEventInput,
  normalizeEventInput,
  eventInstantRange,
  normalizeWall,
} from './event.js'

export {
  MAX_OCCURRENCES,
  expandEvent,
  expandEvents,
} from './recurrence.js'

export {
  findConflicts,
  findFreeSlots,
  checkEventConflicts,
} from './conflict.js'

export {
  STORE_SCHEMA_VERSION,
  emptyStore,
  openStore,
} from './store.js'

export {
  AUDIT_ACTIONS,
  createEventRepo,
} from './event-repo.js'

export {
  parseIcs,
  buildIcs,
  exportJson,
  parseJsonSnapshot,
} from './ics.js'

export {
  DANGEROUS_OPS,
  WRITE_OPS,
  createWorkbenchService,
} from './service.js'

export {
  APPROVAL_MODES,
  approvalFingerprint,
  createHostApprovalGate,
} from './approval-gate.js'

export {
  REMINDER_KINDS,
  BACKENDS,
  DEFAULT_LEAD_MINUTES,
  reminderKeyOf,
  compileReminder,
  createMemoryBackend,
  createHostBackend,
  createScheduleAdapter,
  toHostInstant,
  HOST_READ,
} from './schedule-adapter.js'

export {
  RECOVERY_SCENARIOS,
  DELIVERY_STATE,
  createReminderRecovery,
  rebuildPlans,
} from './reminder-recovery.js'

export { openHostMap } from './host-map.js'

/**
 * WP3：Host Service 适配层（UI 与 Agent 共用的统一业务入口）。
 * 不 import 任何 DSH 包，workbench-core 保持零依赖。
 */
export {
  createWorkbenchHostService,
  applyWorkbenchHostService,
} from './host-service.js'

export {
  TOOL_ERRORS,
  renderValue,
  createWorkbenchToolDefinitions,
  applyWorkbenchTools,
} from './host-tools.js'

/**
 * WP6：AI 规划提案与会话协作（纯数据模型 + 校验 + dispatch op 工厂）。
 * 保持零 DSH 依赖，由 Host 侧注入。
 */
export {
  PROPOSAL_ALLOWED_OPS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  SESSION_ROLES,
  MAX_TEXT_LEN,
  MAX_ITEMS,
  MIN_ESTIMATE_MINUTES,
  MAX_ESTIMATE_MINUTES,
  ProposalValidationError,
  sanitizeUntrustedText,
  checkEstimateMinutes,
  checkProgress,
  buildProposalItem,
  pickPayload,
  buildProposal,
  verifyProposalBinding,
  buildSessionLink,
  buildCompletionRequest,
} from './proposal.js'

export { createProposalOps } from './proposal-ops.js'

/**
 * WP6-B：确定性智能规划引擎（纯函数，复用真实 freeSlots/conflicts）。
 */
export {
  DEFAULT_DAILY_CAPACITY,
  PRIORITY_WEIGHT,
  MAX_SCHEDULE_ITEMS,
  buildPlanSuggestion,
  normalizeTitles,
  inferPriority,
  rankTasks,
  scheduleIntoSlots,
  assertPlanItemsSafe,
} from './planning.js'

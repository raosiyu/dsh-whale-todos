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

/**
 * 统一错误类型。
 *
 * 设计约束：错误必须**带可判定的 code**，调用方（UI / Agent 工具）据此分流，
 * 不靠匹配文案。`details` 只放结构化信息，不放堆栈。
 */

export const ERROR_CODES = Object.freeze({
  VALIDATION: 'validation',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  CONFIRMATION_REQUIRED: 'confirmation-required',
  SCHEMA_TOO_NEW: 'schema-too-new',
  MIGRATION_FAILED: 'migration-failed',
  STORE_CORRUPT: 'store-corrupt',
  UNSUPPORTED: 'unsupported',
})

export class WorkbenchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'WorkbenchError'
    this.code = code
    this.details = details
  }
}

export const validationError = (message, details) =>
  new WorkbenchError(ERROR_CODES.VALIDATION, message, details)

export const notFoundError = (message, details) =>
  new WorkbenchError(ERROR_CODES.NOT_FOUND, message, details)

export const conflictError = (message, details) =>
  new WorkbenchError(ERROR_CODES.CONFLICT, message, details)

export const confirmationRequired = (message, details) =>
  new WorkbenchError(ERROR_CODES.CONFIRMATION_REQUIRED, message, details)

export const unsupportedError = (message, details) =>
  new WorkbenchError(ERROR_CODES.UNSUPPORTED, message, details)

export const storeCorruptError = (message, details) =>
  new WorkbenchError(ERROR_CODES.STORE_CORRUPT, message, details)

export const schemaTooNewError = (message, details) =>
  new WorkbenchError(ERROR_CODES.SCHEMA_TOO_NEW, message, details)

/** 判断是否为可预期的业务错误（而非程序 bug）。 */
export const isWorkbenchError = (error) =>
  error instanceof WorkbenchError && typeof error.code === 'string'

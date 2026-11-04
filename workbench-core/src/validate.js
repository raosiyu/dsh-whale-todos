/**
 * 轻量校验层（零依赖）。
 *
 * 为什么不用 zod：本包要在**隔离环境零安装**下可跑（`node --test` 直接执行），
 * 且不想把供应链面引入核心域。这里只需要「结构化描述 + 校验 + 归一」三件事，
 * 手写足够，且错误信息可以精确到字段路径。
 *
 * 约定：每个校验器是纯函数，输入 unknown，输出归一后的值；失败抛 WorkbenchError(validation)。
 */

import { validationError } from './errors.js'

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

/** @param {unknown} value */
export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {unknown} value */
export const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== ''

/**
 * 逐字段校验并归一。
 *
 * @param {Record<string, unknown>} spec 字段名 → 校验函数（可抛错）
 * @param {unknown} input
 * @param {{ allowUnknown?: boolean, path?: string }} [options]
 * @returns {Record<string, unknown>}
 */
export function validateObject(spec, input, options = {}) {
  const { allowUnknown = false, path = '' } = options
  if (!isPlainObject(input)) {
    throw validationError(`需要一个对象${path ? `（${path}）` : ''}`, { path, got: typeof input })
  }
  const out = {}
  for (const [key, validate] of Object.entries(spec)) {
    const fieldPath = path ? `${path}.${key}` : key
    const isOptional = validate[OPTIONAL] === true
    if (!hasOwn(input, key) || input[key] === undefined) {
      if (isOptional) {
        out[key] = validate(undefined, fieldPath)
        continue
      }
      throw validationError(`缺少必填字段：${fieldPath}`, { path: fieldPath })
    }
    out[key] = validate(input[key], fieldPath)
  }
  if (!allowUnknown) {
    for (const key of Object.keys(input)) {
      if (!hasOwn(spec, key) && input[key] !== undefined) {
        const fieldPath = path ? `${path}.${key}` : key
        throw validationError(`未知字段：${fieldPath}`, { path: fieldPath })
      }
    }
  }
  return out
}

/**
 * 可选字段：缺失/undefined 返回 fallback，存在则校验。
 * @template T
 * @param {(value: unknown, path: string) => T} validate
 * @param {T} fallback
 */
export const OPTIONAL = Symbol('workbench.optional')

/**
 * 可选字段：缺失/undefined 返回 fallback，存在则校验。
 * 产出的校验器带 `OPTIONAL` 标记，`validateObject` 据此不把它当必填。
 */
export const optional = (validate, fallback) => {
  const wrapped = (value, path) => (value === undefined ? fallback : validate(value, path))
  wrapped[OPTIONAL] = true
  return wrapped
}

/** @param {unknown} value @param {string} path */
export const string = (value, path) => {
  if (typeof value !== 'string') throw validationError(`${path} 必须是字符串`, { path, got: typeof value })
  return value
}

/** @param {unknown} value @param {string} path */
export const nonEmptyString = (value, path) => {
  const s = string(value, path)
  if (s.trim() === '') throw validationError(`${path} 不能为空`, { path })
  return s
}

/** @param {unknown} value @param {string} path */
export const boolean = (value, path) => {
  if (typeof value !== 'boolean') throw validationError(`${path} 必须是布尔值`, { path, got: typeof value })
  return value
}

/**
 * @param {{ min?: number, max?: number, integer?: boolean }} [range]
 */
export const number = (range = {}) => (value, path) => {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw validationError(`${path} 必须是有限数字`, { path, got: typeof value })
  }
  if (range.integer && !Number.isInteger(value)) {
    throw validationError(`${path} 必须是整数`, { path, got: value })
  }
  if (range.min !== undefined && value < range.min) {
    throw validationError(`${path} 不能小于 ${range.min}`, { path, got: value })
  }
  if (range.max !== undefined && value > range.max) {
    throw validationError(`${path} 不能大于 ${range.max}`, { path, got: value })
  }
  return value
}

/** @param {readonly string[]} allowed */
export const oneOf = (allowed) => (value, path) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw validationError(`${path} 必须是以下之一：${allowed.join(' / ')}`, { path, got: value, allowed })
  }
  return value
}

/** 数组：每项过同一校验器。 */
export const arrayOf = (itemValidate, range = {}) => (value, path) => {
  if (!Array.isArray(value)) throw validationError(`${path} 必须是数组`, { path, got: typeof value })
  if (range.min !== undefined && value.length < range.min) {
    throw validationError(`${path} 至少 ${range.min} 项`, { path, got: value.length })
  }
  if (range.max !== undefined && value.length > range.max) {
    throw validationError(`${path} 最多 ${range.max} 项`, { path, got: value.length })
  }
  return value.map((item, index) => itemValidate(item, `${path}[${index}]`))
}

/** ISO-8601 时间戳（必须带时区或 Z），归一为 UTC ISO 字符串。 */
export const isoInstant = (value, path) => {
  const s = string(value, path)
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) throw validationError(`${path} 不是合法时间`, { path, got: s })
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw validationError(`${path} 必须带时区（Z 或 ±HH:MM）`, { path, got: s })
  }
  return new Date(ms).toISOString()
}

/** 本地日期 `YYYY-MM-DD`。 */
export const isoDate = (value, path) => {
  const s = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw validationError(`${path} 必须是 YYYY-MM-DD`, { path, got: s })
  }
  const [y, m, d] = s.split('-').map(Number)
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw validationError(`${path} 不是真实存在的日期`, { path, got: s })
  }
  return s
}

/** IANA 时区名；用 Intl 实际解析一次，避免接受 `Mars/Phobos` 这类假名。 */
export const ianaTimeZone = (value, path) => {
  const s = nonEmptyString(value, path)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
  } catch {
    throw validationError(`${path} 不是合法 IANA 时区`, { path, got: s })
  }
  return s
}

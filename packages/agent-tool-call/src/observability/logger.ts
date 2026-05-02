/**
 * 统一日志接口层。
 *
 * 定义了项目中所有模块使用的 Logger 抽象接口。
 *
 * 第三方日志库接入方式：
 *   实现 Logger 接口，然后通过工厂函数注入到 Agent、Runtime、Server 等模块中。
 *
 * 示例（接入 pino）：
 *   import pino from 'pino'
 *   import { loggerFromPino } from './observability/logger.js'
 *   const logger = loggerFromPino(pino())
 */

// ─────────────────────────────────────────────────────────────
// Logger 接口定义
// ─────────────────────────────────────────────────────────────

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 统一 Logger 接口。
 *
 * 所有日志输出必须通过此接口，禁止直接使用 console.log / console.error。
 * 第三方日志库只需实现此接口即可无缝接入。
 */
export interface Logger {
  /** 调试日志（仅在 DEBUG 模式开启时输出） */
  debug(event: string, fields?: Record<string, unknown>): void
  /** 常规信息日志 */
  info(event: string, fields?: Record<string, unknown>): void
  /** 警告日志 */
  warn(event: string, fields?: Record<string, unknown>): void
  /** 错误日志 */
  error(event: string, fields?: Record<string, unknown>): void
  /**
   * 创建带预设上下文的子 Logger。
   * 子 Logger 的所有日志自动携带这些绑定字段（如 request_id, session_id）。
   */
  child(bindings: Record<string, unknown>): Logger
}

/**
 * 工具日志函数类型。
 * Agent 中的工具调用上下文使用此简化签名，兼容 ToolUseContext.log。
 */
export type ToolLogFn = (msg: string, level?: LogLevel) => void

// ─────────────────────────────────────────────────────────────
// 内置控制台实现（默认 Logger）
// ─────────────────────────────────────────────────────────────

/**
 * 创建基于控制台的默认 Logger 实现。
 *
 * 日志格式为结构化 JSON，输出到 stderr。
 * DEBUG 日志仅在 process.env.DEBUG 为真时输出。
 *
 * @param bindings - 预设的上下文字段（如 { service: 'agent-p0' }）
 * @returns Logger 实例
 */
export function createConsoleLogger(
  bindings: Record<string, unknown> = {},
): Logger {
  function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (level === 'debug' && !process.env.DEBUG) return
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...bindings,
      ...fields,
    }
    console.error(JSON.stringify(payload))
  }

  return {
    debug(event, fields) { write('debug', event, fields) },
    info(event, fields) { write('info', event, fields) },
    warn(event, fields) { write('warn', event, fields) },
    error(event, fields) { write('error', event, fields) },
    child(extra) {
      return createConsoleLogger({ ...bindings, ...extra })
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 工具日志适配器
// ─────────────────────────────────────────────────────────────

/**
 * 将 Logger 适配为工具调用上下文的 log 函数。
 *
 * @param logger - Logger 实例
 * @returns 工具日志函数，签名兼容 ToolUseContext.log
 */
export function createToolLogger(logger: Logger): ToolLogFn {
  return (msg: string, level: LogLevel = 'info') => {
    logger[level]('tool_log', { msg })
  }
}

// ─────────────────────────────────────────────────────────────
// 第三方日志库适配器
// ─────────────────────────────────────────────────────────────

/**
 * pino 适配器。
 * 将 pino.Logger 实例包装为项目统一的 Logger 接口。
 *
 * @param pinoLogger - pino 实例
 * @returns Logger 接口实例
 *
 * @example
 *   import pino from 'pino'
 *   const pinoInstance = pino({ level: 'info' })
 *   const appLogger = loggerFromPino(pinoInstance)
 */
export function loggerFromPino(pinoLogger: {
  debug: (obj: Record<string, unknown>, msg?: string) => void
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
  error: (obj: Record<string, unknown>, msg?: string) => void
  child: (bindings: Record<string, unknown>) => unknown
}): Logger {
  function createChild(parent: typeof pinoLogger, bindings: Record<string, unknown>): Logger {
    const childLogger = parent.child(bindings) as typeof pinoLogger
    return {
      debug(event, fields) { childLogger.debug({ event, ...(fields ?? {}) }, event) },
      info(event, fields) { childLogger.info({ event, ...(fields ?? {}) }, event) },
      warn(event, fields) { childLogger.warn({ event, ...(fields ?? {}) }, event) },
      error(event, fields) { childLogger.error({ event, ...(fields ?? {}) }, event) },
      child(extra) { return createChild(childLogger, extra) },
    }
  }

  return createChild(pinoLogger, {})
}

/**
 * winston 适配器。
 * 将 winston.Logger 实例包装为项目统一的 Logger 接口。
 *
 * @param winstonLogger - winston 实例
 * @returns Logger 接口实例
 *
 * @example
 *   import winston from 'winston'
 *   const wLogger = winston.createLogger({ transports: [...] })
 *   const appLogger = loggerFromWinston(wLogger)
 */
export function loggerFromWinston(winstonLogger: {
  debug: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
  child: (bindings: Record<string, unknown>) => unknown
}): Logger {
  function createChild(parent: typeof winstonLogger, bindings: Record<string, unknown>): Logger {
    const childLogger = parent.child(bindings) as typeof winstonLogger
    return {
      debug(event, fields) { childLogger.debug(event, { event, ...(fields ?? {}) }) },
      info(event, fields) { childLogger.info(event, { event, ...(fields ?? {}) }) },
      warn(event, fields) { childLogger.warn(event, { event, ...(fields ?? {}) }) },
      error(event, fields) { childLogger.error(event, { event, ...(fields ?? {}) }) },
      child(extra) { return createChild(childLogger, extra) },
    }
  }

  return createChild(winstonLogger, {})
}

/**
 * 通用 Logger 适配器。
 * 将任意具有 debug/info/warn/error 方法的对象包装为项目统一的 Logger 接口。
 * 适用于绝大多数 Node.js 日志库（bunyan、loglevel、roarr 等）。
 *
 * @param logger - 任意日志对象
 * @returns Logger 接口实例
 *
 * @example
 *   const appLogger = loggerFromGeneric(someCustomLogger)
 */
export function loggerFromGeneric(logger: {
  debug?: (msg: string, meta?: Record<string, unknown>) => void
  info?: (msg: string, meta?: Record<string, unknown>) => void
  warn?: (msg: string, meta?: Record<string, unknown>) => void
  error?: (msg: string, meta?: Record<string, unknown>) => void
  child?: (bindings: Record<string, unknown>) => unknown
}): Logger {
  const noop = () => {}
  const d = logger.debug?.bind(logger) ?? noop
  const i = logger.info?.bind(logger) ?? noop
  const w = logger.warn?.bind(logger) ?? noop
  const e = logger.error?.bind(logger) ?? noop
  const c = logger.child?.bind(logger)

  function createChild(bindings: Record<string, unknown>): Logger {
    if (c) {
      return loggerFromGeneric(c(bindings) as typeof logger)
    }
    const parent = { debug: d, info: i, warn: w, error: e }
    const noopChild = (extra: Record<string, unknown>) =>
      loggerFromGeneric({
        ...parent,
        child: (extra2: Record<string, unknown>) =>
          loggerFromGeneric({ ...parent }).child({ ...extra, ...extra2 }),
      })
    return {
      debug(event, fields) { d(event, { event, ...bindings, ...(fields ?? {}) }) },
      info(event, fields) { i(event, { event, ...bindings, ...(fields ?? {}) }) },
      warn(event, fields) { w(event, { event, ...bindings, ...(fields ?? {}) }) },
      error(event, fields) { e(event, { event, ...bindings, ...(fields ?? {}) }) },
      child: noopChild,
    }
  }

  return {
    debug(event, fields) { d(event, { event, ...(fields ?? {}) }) },
    info(event, fields) { i(event, { event, ...(fields ?? {}) }) },
    warn(event, fields) { w(event, { event, ...(fields ?? {}) }) },
    error(event, fields) { e(event, { event, ...(fields ?? {}) }) },
    child: createChild,
  }
}

// ─────────────────────────────────────────────────────────────
// 向后兼容别名（保留旧 API）
// ─────────────────────────────────────────────────────────────

/** @deprecated 使用 `Logger` 接口替代。 */
export type StructuredLogger = Logger

/**
 * @deprecated 使用 `createConsoleLogger()` 替代。
 * 创建结构化日志记录器，支持子 logger 和工具日志适配器。
 */
export function createStructuredLogger(
  bindings: Record<string, unknown> = {},
): StructuredLogger {
  return createConsoleLogger(bindings)
}

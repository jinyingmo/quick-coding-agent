/** 中文说明：观测与日志模块。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type StructuredLogger = {
  log: (level: LogLevel, event: string, fields?: Record<string, unknown>) => void
  child: (bindings: Record<string, unknown>) => StructuredLogger
  toToolLogger: () => (msg: string, level?: LogLevel) => void
}

/** 创建结构化日志记录器：支持子 logger 和工具日志适配器。 */
export function createStructuredLogger(
  bindings: Record<string, unknown> = {},
): StructuredLogger {
  // 内部写入函数：过滤 debug 级别日志，格式化并输出 JSON 日志行
  function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (level === 'debug' && !process.env.DEBUG) return
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...bindings,
      ...fields,
    }
    console.log(JSON.stringify(payload))
  }

  return {
    log: write,
    // 创建子 logger：合并额外绑定字段
    child(extra) {
      return createStructuredLogger({ ...bindings, ...extra })
    },
    // 创建适配工具调用的日志函数：将 msg 和 level 转为结构化日志事件
    toToolLogger() {
      return (msg: string, level: LogLevel = 'info') => write(level, 'tool_log', { msg })
    },
  }
}

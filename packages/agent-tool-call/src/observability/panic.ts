/**
 * 全局异常捕获与优雅关闭。
 *
 * 安装 process 级别的 uncaughtException 和 unhandledRejection 处理器。
 * 确保进程崩溃前记录错误日志并执行清理。
 */

import type { Logger } from './logger.js'

export type PanicHandlerConfig = {
  /** Logger 实例，用于记录崩溃前日志 */
  logger: Logger
  /** 可选关闭回调，在退出前执行资源清理 */
  onShutdown?: () => Promise<void> | void
  /** 崩溃后退出码，默认 1 */
  exitCode?: number
}

/**
 * 安装全局异常捕获处理器。
 *
 * 监听 uncaughtException 和 unhandledRejection 事件，
 * 记录错误日志后调用 onShutdown 清理资源，最后退出进程。
 *
 * 返回一个注销函数，可在需要时移除这些处理器。
 *
 * @example
 *   const unregister = installPanicHandlers({
 *     logger,
 *     onShutdown: async () => { await server.close() },
 *   })
 *   // 需要移除时调用：
 *   // unregister()
 */
export function installPanicHandlers(config: PanicHandlerConfig): () => void {
  const { logger, exitCode = 1 } = config

  const onUncaught = (err: Error, origin: string) => {
    logger.error('uncaught_exception', {
      message: err.message,
      stack: err.stack ?? '(no stack)',
      origin,
    })

    const shutdown = Promise.resolve(config.onShutdown?.()).catch(shutdownError => {
      logger.error('panic_shutdown_error', {
        message: (shutdownError as Error).message,
      })
    })

    shutdown.finally(() => {
      process.exit(exitCode)
    })
  }

  const uncaughtHandler = (err: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    onUncaught(err, origin)
  }

  const rejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logger.error('unhandled_rejection', {
      message: err.message,
      stack: err.stack ?? '(no stack)',
      promise: String(promise),
    })
  }

  const warningHandler = (warning: Error) => {
    if (warning.name === 'ExperimentalWarning') return
    logger.warn('node_warning', {
      message: warning.message,
      name: warning.name,
      stack: warning.stack ?? '(no stack)',
    })
  }

  process.on('uncaughtException', uncaughtHandler)
  process.on('unhandledRejection', rejectionHandler)
  process.on('warning', warningHandler)

  return () => {
    process.off('uncaughtException', uncaughtHandler)
    process.off('unhandledRejection', rejectionHandler)
    process.off('warning', warningHandler)
  }
}

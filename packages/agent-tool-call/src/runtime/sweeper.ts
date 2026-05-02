/** 中文说明：P0 运行时状态模块。 */

import type { ApprovalRegistry } from './approvalRegistry.js'
import type { SessionRegistry } from './sessionRegistry.js'

/** 启动运行时定期清理器，定时清除过期会话和审批请求，返回停止函数 */
export function startRuntimeSweeper(params: {
  sessionRegistry: SessionRegistry
  approvalRegistry: ApprovalRegistry
  intervalMs?: number
  log?: (msg: string) => void
}): () => void {
  const interval = setInterval(() => {
    const sessions = params.sessionRegistry.sweep()
    const expiredApprovals = params.approvalRegistry.expireStale()
    params.log?.(
      `[runtime-sweeper] expiredSessions=${sessions.expiredSessions.length} evictedSessions=${sessions.evictedSessions.length} expiredApprovals=${expiredApprovals}`,
    )
  }, params.intervalMs ?? 60_000)
  interval.unref()
  return () => clearInterval(interval)
}

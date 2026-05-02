/** 中文说明：P0 运行时状态模块。 */

/** 会话不存在错误 */
export class SessionNotFoundError extends Error {
  /** 构造会话不存在错误 */
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

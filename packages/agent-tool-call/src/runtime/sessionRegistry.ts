/** 中文说明：P0 运行时状态模块。 */

import { randomUUID } from 'crypto'
import type { Message } from '../types.js'
import { SessionNotFoundError } from './errors.js'
import type {
  CreateSessionInput,
  SessionRegistryConfig,
  SessionState,
  SweepResult,
} from './sessionTypes.js'

export type SessionRegistry = {
  create(input: CreateSessionInput): SessionState
  get(sessionId: string): SessionState | undefined
  require(sessionId: string): SessionState
  appendMessage(sessionId: string, message: Message): SessionState
  replaceMessages(sessionId: string, messages: Message[]): SessionState
  touch(sessionId: string): void
  addApproval(sessionId: string, approvalId: string): void
  removeApproval(sessionId: string, approvalId: string): void
  delete(sessionId: string): boolean
  sweep(now?: number): SweepResult
  size(): number
}

/** 创建会话注册表，管理会话的 CRUD、消息追加和过期驱逐 */
export function createSessionRegistry(
  config: SessionRegistryConfig,
): SessionRegistry {
  const sessions = new Map<string, SessionState>()

  // 获取当前时间戳（毫秒）
  function nowTs(): number {
    return Date.now()
  }

  // 安全计算 JSON 序列化后的字符串长度
  function safeJsonLength(value: unknown): number {
    try {
      return JSON.stringify(value).length
    } catch {
      return 0
    }
  }

  // 计算单条消息的字符大小（文本 + 工具调用 + 工具结果）
  function getMessageCharSize(message: Message): number {
    let size = 0
    for (const block of message.content) {
      if (block.type === 'text') {
        size += block.text.length
      } else if (block.type === 'tool_use') {
        size += block.name.length + safeJsonLength(block.input)
      } else if (block.type === 'tool_result') {
        size += block.content.length
      }
    }
    return size
  }

  // 计算消息列表的总字符大小
  function getSessionCharSize(messages: Message[]): number {
    return messages.reduce((sum, message) => sum + getMessageCharSize(message), 0)
  }

  // 按配置限制裁剪消息列表（先按数量裁剪，再按字节数裁剪）
  function trimMessages(messages: Message[]): Message[] {
    let next = [...messages]
    if (next.length > config.maxMessagesPerSession) {
      next = next.slice(next.length - config.maxMessagesPerSession)
    }
    while (
      next.length > 0 &&
      getSessionCharSize(next) > config.maxTotalCharsPerSession
    ) {
      next.shift()
    }
    return next
  }

  // 超限时按最久未访问策略逐出多余会话，返回被逐出会话 ID 列表
  function evictIfNeeded(): string[] {
    const evicted: string[] = []
    while (sessions.size > config.maxSessions) {
      const oldest = [...sessions.values()].sort(
        (a, b) => a.lastAccessAt - b.lastAccessAt,
      )[0]
      if (!oldest) break
      sessions.delete(oldest.sessionId)
      evicted.push(oldest.sessionId)
    }
    return evicted
  }

  return {
    // 创建新会话并写入存储
    create(input: CreateSessionInput): SessionState {
      const now = nowTs()
      const session: SessionState = {
        sessionId: randomUUID(),
        userId: input.userId,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        memoryDir: input.memoryDir,
        messages: [],
        createdAt: now,
        lastAccessAt: now,
        activeApprovalIds: [],
      }
      sessions.set(session.sessionId, session)
      evictIfNeeded()
      return session
    },

    // 按 sessionId 获取会话，返回 undefined 表示不存在
    get(sessionId: string): SessionState | undefined {
      const session = sessions.get(sessionId)
      if (!session) return undefined
      session.lastAccessAt = nowTs()
      return session
    },

    // 按 sessionId 获取会话，不存在时抛出 SessionNotFoundError
    require(sessionId: string): SessionState {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new SessionNotFoundError(sessionId)
      }
      session.lastAccessAt = nowTs()
      return session
    },

    // 向会话追加一条消息并自动裁剪
    appendMessage(sessionId: string, message: Message): SessionState {
      const session = this.require(sessionId)
      session.messages = trimMessages([...session.messages, message])
      session.lastAccessAt = nowTs()
      return session
    },

    // 替换会话的完整消息列表并自动裁剪
    replaceMessages(sessionId: string, messages: Message[]): SessionState {
      const session = this.require(sessionId)
      session.messages = trimMessages(messages)
      session.lastAccessAt = nowTs()
      return session
    },

    // 更新会话的最后访问时间
    touch(sessionId: string): void {
      const session = this.require(sessionId)
      session.lastAccessAt = nowTs()
    },

    // 为会话关联一个审批 ID（去重）
    addApproval(sessionId: string, approvalId: string): void {
      const session = this.require(sessionId)
      if (!session.activeApprovalIds.includes(approvalId)) {
        session.activeApprovalIds.push(approvalId)
      }
      session.lastAccessAt = nowTs()
    },

    // 移除会话关联的指定审批 ID
    removeApproval(sessionId: string, approvalId: string): void {
      const session = this.require(sessionId)
      session.activeApprovalIds = session.activeApprovalIds.filter(
        id => id !== approvalId,
      )
      session.lastAccessAt = nowTs()
    },

    // 删除会话，返回是否实际删除
    delete(sessionId: string): boolean {
      return sessions.delete(sessionId)
    },

    // 清理所有过期会话并驱逐超限会话
    sweep(now = nowTs()): SweepResult {
      const expiredSessions: string[] = []
      for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastAccessAt > config.ttlMs) {
          sessions.delete(sessionId)
          expiredSessions.push(sessionId)
        }
      }
      const evictedSessions = evictIfNeeded()
      return { expiredSessions, evictedSessions }
    },

    // 返回会话总数
    size(): number {
      return sessions.size
    },
  }
}

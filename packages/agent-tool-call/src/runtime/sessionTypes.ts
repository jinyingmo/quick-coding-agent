/** 中文说明：P0 运行时状态模块。 */

import type { Message } from '../types.js'

export type SessionState = {
  sessionId: string
  userId: string
  workspaceId: string
  cwd: string
  memoryDir: string
  messages: Message[]
  createdAt: number
  lastAccessAt: number
  activeApprovalIds: string[]
}

export type CreateSessionInput = {
  userId: string
  workspaceId: string
  cwd: string
  memoryDir: string
}

export type SessionRegistryConfig = {
  ttlMs: number
  maxSessions: number
  maxMessagesPerSession: number
  maxTotalCharsPerSession: number
}

export type SweepResult = {
  expiredSessions: string[]
  evictedSessions: string[]
}

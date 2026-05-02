/** 中文说明：核心 agent 模块。 */

/**
 * Core types for the agent tool-call demo.
 */

import { randomUUID } from 'crypto'
import type { z } from 'zod'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type TextBlock = {
  type: 'text'
  text: string
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export type UserMessage = {
  type: 'user'
  uuid: string
  content: ContentBlock[]
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  content: ContentBlock[]
  stopReason?: 'end_turn' | 'tool_use' | 'max_turns' | 'error'
}

export type Message = UserMessage | AssistantMessage

/** 创建用户消息：接受文本字符串或 ContentBlock 数组。 */
export function createUserMessage(content: ContentBlock[] | string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  }
}

/** 创建助手消息：包含内容块和可选的停止原因。 */
export function createAssistantMessage(
  content: ContentBlock[],
  stopReason?: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    content,
    stopReason,
  }
}

export type ToolUseContext = {
  cwd: string
  memoryDir: string
  agentId?: string
  sessionId?: string
  userId?: string
  workspaceId?: string
  requestId?: string
  log: (msg: string, level?: LogLevel) => void
  signal: AbortSignal
}

export type Tool<Input extends z.ZodType = z.ZodType, Output = unknown> = {
  readonly name: string
  readonly description: string
  readonly source?: 'local' | 'mcp'
  readonly metadata?: {
    server?: string
    originalName?: string
    title?: string
  }
  readonly inputSchema: Input
  readonly jsonSchema?: Record<string, unknown>
  isReadOnly(input: z.infer<Input>): boolean
  call(input: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>
}

export type ToolResult<Output = unknown> = {
  data: Output
  display: string
  isError?: boolean
}

export type ToolApprovalRequest = {
  id: string
  sessionId: string
  userId: string
  workspaceId: string
  actionType: 'bash' | 'write_file' | 'edit_file' | 'mcp'
  toolName: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  summary: string
  reason: string
  input: Record<string, unknown>
  createdAt: number
  expiresAt: number
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
  | { behavior: 'confirm'; message: string; approvalRequest: ToolApprovalRequest }

export type CanUseToolFn = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
) => Promise<PermissionResult>

/** 从助手消息中提取所有 tool_use 块。 */
export function getToolUses(message: AssistantMessage): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

/** 从消息中提取所有文本块的拼接文本。 */
export function getText(message: AssistantMessage | UserMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

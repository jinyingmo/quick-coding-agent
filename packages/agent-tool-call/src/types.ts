/**
 * Core types for the agent tool-call demo.
 *
 * Modeled after the Anthropic SDK message shape used in the parent project
 * (`src/types/message.ts`, `src/Tool.ts`), trimmed to the essentials needed
 * to demonstrate the loop:
 *
 *   - Messages are either `user` or `assistant`.
 *   - Each message carries an array of content blocks: text, tool_use, tool_result.
 *   - A turn ends when the assistant produces a final response with **no**
 *     tool_use blocks (the same condition that triggers stop hooks in the
 *     real codebase, see `handleStopHooks` in `src/query/stopHooks.ts`).
 */

import { randomUUID } from 'crypto'
import type { z } from 'zod'

// ────────────────────────────────────────────────────────────────────────────
// Content blocks
// ────────────────────────────────────────────────────────────────────────────

export type TextBlock = {
  type: 'text'
  text: string
}

export type ToolUseBlock = {
  type: 'tool_use'
  /** Stable id assigned by the LLM (or by us in scripted mode). */
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

// ────────────────────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────────────────────

export type UserMessage = {
  type: 'user'
  uuid: string
  content: ContentBlock[]
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  content: ContentBlock[]
  /** Set on the message that closes the loop (no further tool_use). */
  stopReason?: 'end_turn' | 'tool_use' | 'max_turns' | 'error'
}

export type Message = UserMessage | AssistantMessage

export function createUserMessage(content: ContentBlock[] | string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  }
}

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

// ────────────────────────────────────────────────────────────────────────────
// Tool interface (mirrors `src/Tool.ts` in the parent project, trimmed)
// ────────────────────────────────────────────────────────────────────────────

export type ToolUseContext = {
  /** Working directory the agent was launched in. */
  cwd: string
  /** Memory directory currently in use (passed down so tools can self-validate). */
  memoryDir: string
  /** Set when this context belongs to a forked subagent (e.g. the extractor). */
  agentId?: string
  /** Best-effort logger, plumbed everywhere so tools and hooks can trace. */
  log: (msg: string, level?: 'debug' | 'info' | 'warn' | 'error') => void
  /** Abort signal passed through to fetch / fs operations. */
  signal: AbortSignal
}

/**
 * Tool definition. `Input` is a Zod schema; `call` receives parsed input.
 *
 * The triple (`name`, `description`, `inputSchema`) is what gets shipped to
 * the LLM as a tool definition. `isReadOnly` mirrors the field with the same
 * name in the parent project — the extractor's CanUseToolFn uses it to gate
 * Bash-style commands.
 */
export type Tool<Input extends z.ZodType = z.ZodType, Output = unknown> = {
  readonly name: string
  readonly description: string
  /** Capability source (built-in local tool vs MCP-exposed tool). */
  readonly source?: 'local' | 'mcp'
  /** Optional metadata for observability / diagnostics. */
  readonly metadata?: {
    server?: string
    originalName?: string
    title?: string
  }
  readonly inputSchema: Input
  /** Optional pre-baked JSON schema (used by MCP-adapted tools). */
  readonly jsonSchema?: Record<string, unknown>
  isReadOnly(input: z.infer<Input>): boolean
  call(input: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>
}

export type ToolResult<Output = unknown> = {
  /** Raw structured value returned by the tool. */
  data: Output
  /** Human-readable string sent back to the model as the tool_result block content. */
  display: string
  isError?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Permissions
// ────────────────────────────────────────────────────────────────────────────

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export type CanUseToolFn = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
) => Promise<PermissionResult>

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

export function getToolUses(message: AssistantMessage): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

export function getText(message: AssistantMessage | UserMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

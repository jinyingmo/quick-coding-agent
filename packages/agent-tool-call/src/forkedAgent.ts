import { randomUUID } from 'crypto'
import type {
  AssistantMessage,
  CanUseToolFn,
  Message,
  Tool,
  ToolUseContext,
} from './types.js'
import { createUserMessage } from './types.js'
import { runQueryLoop, type QueryResult } from './query.js'

export type ForkedAgentParams = {
  parentSystemPrompt: string
  parentMessages: Message[]
  tools: Tool[]
  canUseTool: CanUseToolFn
  parentContext: ToolUseContext
  prompt: string
  maxTurns?: number
  forkLabel: string
}

export async function runForkedAgent(params: ForkedAgentParams): Promise<QueryResult> {
  const { parentSystemPrompt, parentMessages, tools, canUseTool, parentContext } = params
  const agentId = `${params.forkLabel}-${randomUUID().slice(0, 8)}`

  const subContext: ToolUseContext = {
    ...parentContext,
    agentId,
    log: (msg, level) => parentContext.log(`[${agentId}] ${msg}`, level),
  }

  subContext.log(
    `forking — inheriting ${parentMessages.length} messages, maxTurns=${params.maxTurns ?? 5}`,
    'debug',
  )

  const promptMessage = createUserMessage(params.prompt)

  return runQueryLoop({
    systemPrompt: parentSystemPrompt,
    messages: [...parentMessages, promptMessage],
    tools,
    canUseTool,
    context: subContext,
    maxTurns: params.maxTurns ?? 5,
    isForkedAgent: true,
  })
}

export function extractWrittenPaths(messages: Message[]): string[] {
  const paths: string[] = []
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    for (const block of m.content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'write_file' &&
        typeof (block.input as { file_path?: unknown }).file_path === 'string'
      ) {
        paths.push((block.input as { file_path: string }).file_path)
      }
    }
  }
  return [...new Set(paths)]
}

export function hasMemoryWritesSince(
  messages: Message[],
  sinceUuid: string | undefined,
  memoryDir: string,
): boolean {
  let found = sinceUuid === undefined
  for (const m of messages) {
    if (!found) {
      if (m.uuid === sinceUuid) found = true
      continue
    }
    if (m.type !== 'assistant') continue
    for (const block of m.content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'write_file' &&
        typeof (block.input as { file_path?: unknown }).file_path === 'string' &&
        (block.input as { file_path: string }).file_path.startsWith(memoryDir)
      ) {
        return true
      }
    }
  }
  return false
}

export type { AssistantMessage }
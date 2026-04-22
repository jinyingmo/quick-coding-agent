/**
 * The agent query loop.
 *
 * Modeled after `queryLoop` in `src/query.ts` of the parent project, trimmed
 * to the bare essentials so the topology is easy to read:
 *
 *   while (turns < maxTurns) {
 *     assistant = call LLM with [system, ...history]
 *     append assistant
 *     if (assistant has no tool_use) break    // ← terminal condition
 *     execute every tool_use in parallel
 *       — gated by canUseTool
 *       — denials are reported back as tool_result with is_error=true
 *     append the tool_result blocks as one synthetic user message
 *   }
 *   run stopHooks (fire-and-forget extractMemories on the way out)
 *
 * The "stop hook fires when the model produces a response with no tool_use"
 * is the same pattern the real codebase uses to drive `executeExtractMemories`
 * (see `src/query/stopHooks.ts`).
 */

import type {
  AssistantMessage,
  CanUseToolFn,
  ContentBlock,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseContext,
} from './types.js'
import { createUserMessage, getToolUses } from './types.js'
import { callLLM, type LLMConfig } from './llm.js'

export type StopHookFn = (params: {
  messages: Message[]
  context: ToolUseContext
}) => void | Promise<void>

export type QueryParams = {
  systemPrompt: string
  /** Initial conversation messages; the loop appends to this array. */
  messages: Message[]
  tools: Tool[]
  canUseTool: CanUseToolFn
  context: ToolUseContext
  /** Hard cap on assistant turns. Mirrors `maxTurns` in the parent project. */
  maxTurns?: number
  /** Optional LLM override (used by `runForkedAgent` to share config). */
  llmConfig?: LLMConfig
  /**
   * Hooks executed after the loop terminates with no further tool_use.
   * Errors are caught and logged so a misbehaving hook can't break the turn.
   */
  stopHooks?: StopHookFn[]
  /** Set true when this loop is itself a forked subagent — disables stopHooks. */
  isForkedAgent?: boolean
}

export type QueryResult = {
  /** Final assistant message that closed the loop. */
  finalMessage: AssistantMessage
  /** Full message history including everything the loop appended. */
  messages: Message[]
  /** Number of assistant turns executed. */
  turns: number
  stopReason: 'end_turn' | 'max_turns' | 'error'
}

/**
 * Run a single tool_use block: validate via canUseTool, then dispatch to
 * `tool.call(...)`. Returns a tool_result block in either case so the LLM
 * always gets back exactly one result per tool_use it emitted (the SDK
 * crashes otherwise — see the comment in `query.ts` of the parent repo).
 */
async function executeToolUse(
  toolUse: ToolUseBlock,
  tools: Tool[],
  canUseTool: CanUseToolFn,
  context: ToolUseContext,
): Promise<ToolResultBlock> {
  const tool = tools.find(t => t.name === toolUse.name)
  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true,
    }
  }

  const permission = await canUseTool(tool, toolUse.input, context)
  if (permission.behavior === 'deny') {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: permission.message,
      is_error: true,
    }
  }

  const parsed = tool.inputSchema.safeParse(permission.updatedInput)
  if (!parsed.success) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Invalid input for ${toolUse.name}: ${parsed.error.message}`,
      is_error: true,
    }
  }

  try {
    const result = await tool.call(parsed.data, context)
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: result.display,
      is_error: result.isError === true,
    }
  } catch (err) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Tool ${toolUse.name} threw: ${(err as Error).message}`,
      is_error: true,
    }
  }
}

export async function runQueryLoop(params: QueryParams): Promise<QueryResult> {
  const {
    systemPrompt,
    tools,
    canUseTool,
    context,
    maxTurns = 10,
    llmConfig,
    stopHooks,
    isForkedAgent,
  } = params
  const messages: Message[] = [...params.messages]

  let turns = 0
  let finalMessage: AssistantMessage | undefined
  let stopReason: QueryResult['stopReason'] = 'end_turn'

  while (turns < maxTurns) {
    turns++
    context.log(`[query] turn ${turns}/${maxTurns} → calling LLM`, 'debug')

    let assistant: AssistantMessage
    try {
      assistant = await callLLM({
        systemPrompt,
        history: messages,
        tools,
        config: llmConfig,
        signal: context.signal,
      })
    } catch (err) {
      context.log(`[query] LLM error: ${(err as Error).message}`, 'error')
      stopReason = 'error'
      finalMessage = {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        content: [{ type: 'text', text: `LLM error: ${(err as Error).message}` }],
        stopReason: 'error',
      }
      messages.push(finalMessage)
      break
    }

    // ── Log each model response ──────────────────────────────────────────────
    {
      const textBlocks = assistant.content.filter(b => b.type === 'text')
      const toolUseBlocks = assistant.content.filter(b => b.type === 'tool_use')

      context.log(
        `[llm-response] turn=${turns} stopReason=${assistant.stopReason} ` +
          `blocks=${assistant.content.length} ` +
          `(text=${textBlocks.length}, tool_use=${toolUseBlocks.length})`,
        'info',
      )

      // Log text content (trimmed to 200 chars to stay readable)
      for (const block of textBlocks) {
        if (block.type === 'text' && block.text) {
          const preview = block.text.length > 200 ? block.text.slice(0, 200) + '…' : block.text
          context.log(`[llm-response]   text: ${preview}`, 'info')
        }
      }

      // Log every tool_use call with its arguments
      for (const block of toolUseBlocks) {
        if (block.type === 'tool_use') {
          context.log(
            `[llm-response]   tool_use id=${block.id} name=${block.name} ` +
              `input=${JSON.stringify(block.input)}`,
            'info',
          )
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    messages.push(assistant)
    finalMessage = assistant

    const toolUses = getToolUses(assistant)
    if (toolUses.length === 0) {
      stopReason = 'end_turn'
      break
    }

    // Execute all tool_use blocks in parallel — same as `query.ts` does.
    context.log(
      `[query] executing ${toolUses.length} tool call(s): ${toolUses
        .map(t => t.name)
        .join(', ')}`,
      'debug',
    )
    const results = await Promise.all(
      toolUses.map(t => executeToolUse(t, tools, canUseTool, context)),
    )

    // Wrap all results into one synthetic user message — mirrors how the
    // SDK serializes a turn back into the next request.
    const resultBlocks: ContentBlock[] = results
    messages.push(createUserMessage(resultBlocks))
  }

  if (turns >= maxTurns && finalMessage && getToolUses(finalMessage).length > 0) {
    stopReason = 'max_turns'
    context.log(`[query] hit max_turns=${maxTurns}, stopping`, 'warn')
  }

  // Stop hooks (extractMemories etc.) — only on the main agent, never on a
  // forked subagent (otherwise an extractor would recursively trigger itself).
  if (!isForkedAgent && stopHooks && stopHooks.length > 0) {
    for (const hook of stopHooks) {
      try {
        await hook({ messages, context })
      } catch (err) {
        context.log(`[query] stop hook error: ${(err as Error).message}`, 'warn')
      }
    }
  }

  return {
    finalMessage: finalMessage!,
    messages,
    turns,
    stopReason,
  }
}

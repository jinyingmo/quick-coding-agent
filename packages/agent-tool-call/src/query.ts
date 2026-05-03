/** 中文说明：核心 agent 模块。 */

import type {
  AssistantMessage,
  CanUseToolFn,
  ContentBlock,
  Message,
  Tool,
  ToolApprovalRequest,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseContext,
} from './types.js'
import { createAssistantMessage, createUserMessage, getToolUses } from './types.js'
import {
  callLLM,
  callLLMStream,
  type LLMConfig,
  type TokenUsage,
} from './llm.js'

export type StopHookFn = (params: {
  messages: Message[]
  context: ToolUseContext
}) => void | Promise<void>

export type QueryParams = {
  systemPrompt: string
  messages: Message[]
  tools: Tool[]
  canUseTool: CanUseToolFn
  context: ToolUseContext
  maxTurns?: number
  llmConfig?: LLMConfig
  stopHooks?: StopHookFn[]
  isForkedAgent?: boolean
}

export type QueryResult = {
  status: 'completed' | 'confirm_required' | 'error'
  finalMessage?: AssistantMessage
  messages: Message[]
  turns: number
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'confirm_required'
  approvalRequest?: ToolApprovalRequest
  reason?: string
  usage?: TokenUsage
}

export type QueryStreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; id: string; name?: string; arguments: string }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError: boolean }
  | {
      type: 'confirm_required'
      approvalId: string
      reason: string
      toolName: string
      toolUseId: string
    }
  | { type: 'done'; finishReason: QueryResult['stopReason']; usage?: TokenUsage }

type PreflightOutcome =
  | {
      kind: 'execute'
      toolUse: ToolUseBlock
      tool: Tool
      parsedInput: Record<string, unknown>
    }
  | {
      kind: 'result'
      toolUseId: string
      result: ToolResultBlock
    }
  | {
      kind: 'confirm'
      approvalRequest: ToolApprovalRequest
      reason: string
    }

// 工具调用预检：验证工具存在、权限检查和输入校验
async function preflightToolUse(
  toolUse: ToolUseBlock,
  tools: Tool[],
  canUseTool: CanUseToolFn,
  context: ToolUseContext,
): Promise<PreflightOutcome> {
  const tool = tools.find(t => t.name === toolUse.name)
  if (!tool) {
    return {
      kind: 'result',
      toolUseId: toolUse.id,
      result: {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Unknown tool: ${toolUse.name}`,
        is_error: true,
      },
    }
  }

  const permission = await canUseTool(tool, toolUse.input, context)
  if (permission.behavior === 'deny') {
    return {
      kind: 'result',
      toolUseId: toolUse.id,
      result: {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: permission.message,
        is_error: true,
      },
    }
  }

  if (permission.behavior === 'confirm') {
    return {
      kind: 'confirm',
      approvalRequest: permission.approvalRequest,
      reason: permission.message,
    }
  }

  const parsed = tool.inputSchema.safeParse(permission.updatedInput)
  if (!parsed.success) {
    return {
      kind: 'result',
      toolUseId: toolUse.id,
      result: {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Invalid input for ${toolUse.name}: ${parsed.error.message}`,
        is_error: true,
      },
    }
  }

  return {
    kind: 'execute',
    toolUse,
    tool,
    parsedInput: parsed.data as Record<string, unknown>,
  }
}

// 执行已通过预检的工具调用并返回结果
async function executePlannedToolUse(
  outcome: Extract<PreflightOutcome, { kind: 'execute' }>,
  context: ToolUseContext,
): Promise<ToolResultBlock> {
  try {
    const result = await outcome.tool.call(outcome.parsedInput, context)
    return {
      type: 'tool_result',
      tool_use_id: outcome.toolUse.id,
      content: result.display,
      is_error: result.isError === true,
    }
  } catch (err) {
    return {
      type: 'tool_result',
      tool_use_id: outcome.toolUse.id,
      content: `Tool ${outcome.toolUse.name} threw: ${(err as Error).message}`,
      is_error: true,
    }
  }
}

function accumulateUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return current
  if (!current) return { ...next }
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  }
}

function createErrorAssistant(message: string): AssistantMessage {
  return createAssistantMessage([{ type: 'text', text: message }], 'error')
}

async function runStopHooksIfNeeded(
  stopHooks: StopHookFn[] | undefined,
  isForkedAgent: boolean | undefined,
  messages: Message[],
  context: ToolUseContext,
): Promise<void> {
  if (isForkedAgent || !stopHooks || stopHooks.length === 0) return

  for (const hook of stopHooks) {
    try {
      await hook({ messages, context })
    } catch (err) {
      context.log(`[query] stop hook error: ${(err as Error).message}`, 'warn')
    }
  }
}

/** 运行查询循环：交替调用 LLM 和执行工具调用，直到对话结束。 */
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
    context.log(`[query] turn ${turns}/${maxTurns} -> calling LLM`, 'debug')

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
      finalMessage = createErrorAssistant(`LLM error: ${(err as Error).message}`)
      messages.push(finalMessage)
      break
    }

    messages.push(assistant)
    finalMessage = assistant

    const toolUses = getToolUses(assistant)
    if (toolUses.length === 0) {
      stopReason = 'end_turn'
      break
    }

    const planned: PreflightOutcome[] = []
    for (const toolUse of toolUses) {
      const outcome = await preflightToolUse(toolUse, tools, canUseTool, context)
      if (outcome.kind === 'confirm') {
        context.log(
          `[query] approval required for tool_use=${toolUse.id} tool=${toolUse.name}: ${outcome.reason}`,
          'warn',
        )
        return {
          status: 'confirm_required',
          messages,
          turns,
          stopReason: 'confirm_required',
          approvalRequest: outcome.approvalRequest,
          reason: outcome.reason,
        }
      }
      planned.push(outcome)
    }

    const orderedResults: ToolResultBlock[] = []
    for (const outcome of planned) {
      if (outcome.kind === 'result') {
        orderedResults.push(outcome.result)
      } else if (outcome.kind === 'execute') {
        orderedResults.push(await executePlannedToolUse(outcome, context))
      }
    }

    const resultBlocks: ContentBlock[] = orderedResults
    messages.push(createUserMessage(resultBlocks))
  }

  if (turns >= maxTurns && finalMessage && getToolUses(finalMessage).length > 0) {
    stopReason = 'max_turns'
    context.log(`[query] hit max_turns=${maxTurns}, stopping`, 'warn')
  }

  await runStopHooksIfNeeded(stopHooks, isForkedAgent, messages, context)

  return {
    status: stopReason === 'error' ? 'error' : 'completed',
    finalMessage: finalMessage!,
    messages,
    turns,
    stopReason,
  }
}

export async function* runQueryLoopStream(
  params: QueryParams,
): AsyncGenerator<QueryStreamChunk, QueryResult> {
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
  let usage: TokenUsage | undefined

  while (turns < maxTurns) {
    turns++
    context.log(`[query] turn ${turns}/${maxTurns} -> calling LLM (stream)`, 'debug')

    let assistant: AssistantMessage
    let turnUsage: TokenUsage | undefined

    try {
      const stream = callLLMStream({
        systemPrompt,
        history: messages,
        tools,
        config: llmConfig,
        signal: context.signal,
      })

      while (true) {
        const { value, done } = await stream.next()
        if (done) {
          assistant = value.assistant
          turnUsage = value.usage
          break
        }
        if (value.type === 'done') continue
        yield value
      }
    } catch (err) {
      context.log(`[query] LLM stream error: ${(err as Error).message}`, 'error')
      stopReason = 'error'
      finalMessage = createErrorAssistant(`LLM stream error: ${(err as Error).message}`)
      messages.push(finalMessage)
      await runStopHooksIfNeeded(stopHooks, isForkedAgent, messages, context)
      yield { type: 'done', finishReason: stopReason, usage }
      return {
        status: 'error',
        finalMessage,
        messages,
        turns,
        stopReason,
        usage,
      }
    }

    usage = accumulateUsage(usage, turnUsage)
    messages.push(assistant)
    finalMessage = assistant

    const toolUses = getToolUses(assistant)
    if (toolUses.length === 0) {
      stopReason = 'end_turn'
      break
    }

    const planned: Array<PreflightOutcome & { toolName?: string }> = []
    for (const toolUse of toolUses) {
      const outcome = await preflightToolUse(toolUse, tools, canUseTool, context)
      if (outcome.kind === 'confirm') {
        context.log(
          `[query] approval required for tool_use=${toolUse.id} tool=${toolUse.name}: ${outcome.reason}`,
          'warn',
        )
        yield {
          type: 'confirm_required',
          approvalId: outcome.approvalRequest.id,
          reason: outcome.reason,
          toolName: toolUse.name,
          toolUseId: toolUse.id,
        }
        return {
          status: 'confirm_required',
          messages,
          turns,
          stopReason: 'confirm_required',
          approvalRequest: outcome.approvalRequest,
          reason: outcome.reason,
          usage,
        }
      }
      planned.push(
        outcome.kind === 'execute'
          ? { ...outcome, toolName: outcome.toolUse.name }
          : { ...outcome, toolName: toolUse.name },
      )
    }

    const orderedResults: ToolResultBlock[] = []
    for (const outcome of planned) {
      if (outcome.kind === 'result') {
        orderedResults.push(outcome.result)
        yield {
          type: 'tool_result',
          toolUseId: outcome.result.tool_use_id,
          toolName: outcome.toolName ?? 'unknown',
          content: outcome.result.content,
          isError: outcome.result.is_error === true,
        }
      } else if (outcome.kind === 'execute') {
        const toolResult = await executePlannedToolUse(outcome, context)
        orderedResults.push(toolResult)
        yield {
          type: 'tool_result',
          toolUseId: toolResult.tool_use_id,
          toolName: outcome.toolUse.name,
          content: toolResult.content,
          isError: toolResult.is_error === true,
        }
      }
    }

    messages.push(createUserMessage(orderedResults))
  }

  if (turns >= maxTurns && finalMessage && getToolUses(finalMessage).length > 0) {
    stopReason = 'max_turns'
    context.log(`[query] hit max_turns=${maxTurns}, stopping`, 'warn')
  }

  await runStopHooksIfNeeded(stopHooks, isForkedAgent, messages, context)
  yield { type: 'done', finishReason: stopReason, usage }

  return {
    status: 'completed',
    finalMessage: finalMessage!,
    messages,
    turns,
    stopReason,
    usage,
  }
}

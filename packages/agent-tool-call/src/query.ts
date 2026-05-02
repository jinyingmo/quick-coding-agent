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
import { createUserMessage, getToolUses } from './types.js'
import { callLLM, type LLMConfig } from './llm.js'

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
}

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
      finalMessage = {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        content: [{ type: 'text', text: `LLM error: ${(err as Error).message}` }],
        stopReason: 'error',
      }
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
    status: stopReason === 'error' ? 'error' : 'completed',
    finalMessage: finalMessage!,
    messages,
    turns,
    stopReason,
  }
}

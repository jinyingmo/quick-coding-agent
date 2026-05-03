import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runQueryLoopStream } from '../src/query.js'
import {
  createAssistantMessage,
  createUserMessage,
  type Tool,
  type ToolApprovalRequest,
} from '../src/types.js'
import { callLLMStream, type LLMStreamResult } from '../src/llm.js'

vi.mock('../src/llm.js', () => ({
  callLLM: vi.fn(),
  callLLMStream: vi.fn(),
}))

const mockedCallLLMStream = vi.mocked(callLLMStream)

function makeStream(
  events: Array<
    | { type: 'text_delta'; text: string }
    | { type: 'tool_call_delta'; id: string; name?: string; arguments: string }
  >,
  result: LLMStreamResult,
): AsyncGenerator<(typeof events)[number], LLMStreamResult> {
  return (async function* () {
    for (const event of events) {
      yield event
    }
    return result
  })()
}

describe('runQueryLoopStream', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('streams tool loops with the same semantics as non-stream mode', async () => {
    mockedCallLLMStream
      .mockReturnValueOnce(
        makeStream(
          [
            {
              type: 'tool_call_delta',
              id: 'tool-1',
              name: 'echo',
              arguments: '{"value":"hi"}',
            },
          ],
          {
            assistant: createAssistantMessage(
              [{ type: 'tool_use', id: 'tool-1', name: 'echo', input: { value: 'hi' } }],
              'tool_use',
            ),
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
          },
        ),
      )
      .mockReturnValueOnce(
        makeStream(
          [{ type: 'text_delta', text: 'done' }],
          {
            assistant: createAssistantMessage([{ type: 'text', text: 'done' }], 'end_turn'),
            usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
          },
        ),
      )

    const echoTool: Tool = {
      name: 'echo',
      description: 'Echo back input.',
      inputSchema: z.object({ value: z.string() }),
      isReadOnly: () => true,
      async call(input) {
        return {
          data: { echoed: input.value },
          display: `echo:${String(input.value)}`,
        }
      },
    }

    const gen = runQueryLoopStream({
      systemPrompt: 'You are helpful.',
      messages: [createUserMessage('say hi')],
      tools: [echoTool],
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      context: {
        cwd: '/repo',
        memoryDir: '/repo/memory',
        log: () => undefined,
        signal: new AbortController().signal,
      },
    })

    const chunks: Array<{ type: string; [key: string]: unknown }> = []
    let result
    while (true) {
      const step = await gen.next()
      if (step.done) {
        result = step.value
        break
      }
      chunks.push(step.value)
    }

    expect(chunks).toEqual([
      {
        type: 'tool_call_delta',
        id: 'tool-1',
        name: 'echo',
        arguments: '{"value":"hi"}',
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        toolName: 'echo',
        content: 'echo:hi',
        isError: false,
      },
      { type: 'text_delta', text: 'done' },
      { type: 'done', finishReason: 'end_turn', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } },
    ])
    expect(result.status).toBe('completed')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    })
    expect(result.messages).toHaveLength(4)
    expect(result.finalMessage?.content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('surfaces approval requests while streaming and stops before tool execution', async () => {
    mockedCallLLMStream.mockReturnValueOnce(
      makeStream(
        [
          {
            type: 'tool_call_delta',
            id: 'tool-1',
            name: 'bash',
            arguments: '{"command":"npm install"}',
          },
        ],
        {
          assistant: createAssistantMessage(
            [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'bash',
                input: { command: 'npm install' },
              },
            ],
            'tool_use',
          ),
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        },
      ),
    )

    const approvalRequest: ToolApprovalRequest = {
      id: 'apr-1',
      sessionId: 'sess-1',
      userId: 'demo-user',
      workspaceId: 'demo-workspace',
      actionType: 'bash',
      toolName: 'bash',
      riskLevel: 'high',
      summary: 'Install dependencies',
      reason: 'Needs approval',
      input: { command: 'npm install' },
      createdAt: 1,
      expiresAt: 2,
    }

    const bashTool: Tool = {
      name: 'bash',
      description: 'Run shell commands.',
      inputSchema: z.object({ command: z.string() }),
      isReadOnly: () => false,
      async call() {
        throw new Error('should not execute')
      },
    }

    const gen = runQueryLoopStream({
      systemPrompt: 'You are helpful.',
      messages: [createUserMessage('install deps')],
      tools: [bashTool],
      canUseTool: async () => ({
        behavior: 'confirm',
        message: 'Needs approval',
        approvalRequest,
      }),
      context: {
        cwd: '/repo',
        memoryDir: '/repo/memory',
        log: () => undefined,
        signal: new AbortController().signal,
      },
    })

    const chunks: Array<{ type: string; [key: string]: unknown }> = []
    let result
    while (true) {
      const step = await gen.next()
      if (step.done) {
        result = step.value
        break
      }
      chunks.push(step.value)
    }

    expect(chunks).toEqual([
      {
        type: 'tool_call_delta',
        id: 'tool-1',
        name: 'bash',
        arguments: '{"command":"npm install"}',
      },
      {
        type: 'confirm_required',
        approvalId: 'apr-1',
        reason: 'Needs approval',
        toolName: 'bash',
        toolUseId: 'tool-1',
      },
    ])
    expect(result.status).toBe('confirm_required')
    expect(result.approvalRequest?.id).toBe('apr-1')
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 })
  })
})

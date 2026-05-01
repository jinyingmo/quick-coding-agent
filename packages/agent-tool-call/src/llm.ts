/**
 * Kimi (Moonshot) LLM client with tool-calling support.
 *
 * Moonshot's HTTP API is OpenAI-compatible (POST /chat/completions, with the
 * standard `tools` / `tool_calls` shape), so we adopt OpenAI's wire format and
 * translate to/from our internal Anthropic-style ContentBlock model:
 *
 *   internal `tool_use`     ↔  OpenAI assistant `tool_calls[i]`
 *   internal `tool_result`  ↔  OpenAI message with role: 'tool'
 *
 * The translation is intentionally one-to-one and stateless so the queryLoop
 * can stay agnostic of the wire format.
 */

import { z } from 'zod'
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js'
import { createAssistantMessage } from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

export type LLMConfig = {
  apiKey: string | undefined
  model: string
  baseUrl: string
  timeoutMs: number
}

export function loadLLMConfig(): LLMConfig {
  return {
    apiKey: process.env.KIMI_API_KEY,
    model: process.env.KIMI_MODEL ?? 'moonshot-v1-8k',
    baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.cn/v1',
    timeoutMs: parseInt(process.env.KIMI_TIMEOUT_MS ?? '30000', 10),
  }
}

export function isLLMAvailable(cfg: LLMConfig = loadLLMConfig()): boolean {
  return !!cfg.apiKey && cfg.apiKey.length > 0
}

// ────────────────────────────────────────────────────────────────────────────
// Zod → JSON Schema (minimal, just enough for tool definitions)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Zod schema to the JSON Schema subset Moonshot accepts.
 * We intentionally keep this small: object / string / number / boolean,
 * plus optional + description, which covers everything our tools declare.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value)
      if (!(value instanceof z.ZodOptional)) {
        required.push(key)
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    }
  }
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap())
  }
  if (schema instanceof z.ZodString) {
    const desc = schema.description
    return desc ? { type: 'string', description: desc } : { type: 'string' }
  }
  if (schema instanceof z.ZodNumber) {
    const desc = schema.description
    return desc ? { type: 'number', description: desc } : { type: 'number' }
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element) }
  }
  return { type: 'string' }
}

// ────────────────────────────────────────────────────────────────────────────
// Internal ↔ OpenAI message translation
// ────────────────────────────────────────────────────────────────────────────

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string }

/**
 * Flatten a single internal Message into one or more OpenAI messages.
 * A user message containing tool_result blocks expands into multiple
 * `role: 'tool'` entries, exactly mirroring the SDK's expectation.
 */
function toOpenAIMessages(message: Message): OpenAIMessage[] {
  if (message.type === 'user') {
    const out: OpenAIMessage[] = []
    let textBuffer = ''
    for (const block of message.content) {
      if (block.type === 'text') {
        textBuffer += (textBuffer ? '\n' : '') + block.text
      } else if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content,
        })
      }
    }
    if (textBuffer) {
      out.unshift({ role: 'user', content: textBuffer })
    }
    return out
  }

  // assistant
  let text = ''
  const toolCalls: OpenAIToolCall[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      text += (text ? '\n' : '') + block.text
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }
  return [
    {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

export function buildOpenAIMessages(
  systemPrompt: string,
  history: Message[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const m of history) {
    out.push(...toOpenAIMessages(m))
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export type LLMCallOptions = {
  systemPrompt: string
  history: Message[]
  tools: Tool[]
  config?: LLMConfig
  signal?: AbortSignal
}

/**
 * Invoke the LLM once, returning a fully-formed AssistantMessage.
 *
 * The caller (queryLoop) decides whether to terminate (no tool_use blocks)
 * or to dispatch the tool calls and run another iteration.
 */
export async function callLLM(opts: LLMCallOptions): Promise<AssistantMessage> {
  const cfg = opts.config ?? loadLLMConfig()
  if (!cfg.apiKey) {
    throw new Error(
      'KIMI_API_KEY is not set — start the demo in --scripted mode or configure your .env',
    )
  }

  const tools = opts.tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema ?? zodToJsonSchema(t.inputSchema),
    },
  }))

  const body = {
    model: cfg.model,
    messages: buildOpenAIMessages(opts.systemPrompt, opts.history),
    tools,
    tool_choice: 'auto' as const,
    temperature: 0.2,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs)
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort())
  }

  if (process.env.DEBUG) {
    console.error('[llm] request body:', JSON.stringify(body, null, 2))
  }

  let response: Response
  try {
    response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(`Kimi API ${response.status}: ${text}`)
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: OpenAIToolCall[]
      }
      finish_reason?: string
    }>
  }

  const choice = json.choices?.[0]
  const msg = choice?.message
  if (!msg) {
    throw new Error('Kimi API returned no choices/message')
  }

  if (process.env.DEBUG) {
    console.error('[llm] response:', JSON.stringify(json, null, 2))
  }

  const blocks: ContentBlock[] = []
  if (msg.content) {
    blocks.push({ type: 'text', text: msg.content })
  }
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const call of msg.tool_calls) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        parsed = { __raw: call.function.arguments }
      }
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parsed,
      }
      blocks.push(block)
    }
  }

  // If the model returned literally nothing (e.g. an upstream filter), fall
  // back to a single empty text block so the queryLoop has a stable shape.
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' })
  }

  const stopReason: AssistantMessage['stopReason'] =
    msg.tool_calls && msg.tool_calls.length > 0 ? 'tool_use' : 'end_turn'
  return createAssistantMessage(blocks, stopReason)
}

// ────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ────────────────────────────────────────────────────────────────────────────

export type { AssistantMessage, ContentBlock, ToolResultBlock, ToolUseBlock }

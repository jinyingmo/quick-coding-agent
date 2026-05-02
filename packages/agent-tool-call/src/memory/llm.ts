/** 中文说明：内置记忆子系统。 */

/**
 * OpenAI-compatible LLM client for memory relevance selection.
 *
 * Provides a side-query style interface that calls any OpenAI-compatible API
 * to semantically select the most relevant memories for a user query.
 *
 * Compatible with OpenAI-style API format:
 *   POST {baseUrl}/chat/completions
 */

import OpenAI from 'openai'
import type { MemoryConfig } from './config.js'
import type { MemoryHeader } from './types.js'
import { formatMemoryManifest } from './scanner.js'

export type LLMSelectResult = {
  selected: string[]
  fromCache: boolean
  model: string
}

export type LLMSelectOptions = {
  config: MemoryConfig
  signal?: AbortSignal
  recentTools?: string[]
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" field containing a list of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.

Rules:
- If you are unsure if a memory will be useful, do not include it. Be selective and discerning.
- If no memories would clearly be useful, return an empty array.
- Do not guess. Base your selection only on the provided filenames and descriptions.
- Output must be valid JSON in this exact format: {"selected_memories": ["filename1.md", "filename2.md"]}
`

/**
 * 调用 LLM API 为查询选择最相关的记忆文件，失败时返回 null 以优雅降级。
 *
 * Call LLM API to select relevant memories for a query.
 *
 * @param query 用户查询文本
 * @param memories 可用记忆文件头信息列表
 * @param options 配置与可选 AbortSignal
 * @returns 选中的文件名列表，调用失败返回 null
 */
export async function callLLMSelectMemories(
  query: string,
  memories: MemoryHeader[],
  options: LLMSelectOptions,
): Promise<LLMSelectResult | null> {
  const { config, signal, recentTools } = options

  if (!config.llmApiKey) {
    return null
  }

  const manifest = formatMemoryManifest(memories)

  const toolsSection =
    recentTools && recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  const userContent = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`

  const client = new OpenAI({
    apiKey: config.llmApiKey,
    baseURL: config.llmBaseUrl,
    timeout: config.llmTimeoutMs,
    maxRetries: 0,
  })

  try {
    const response = await client.chat.completions.create(
      {
        model: config.llmModel,
        messages: [
          { role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: 256,
      },
      { signal },
    )

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('LLM API returned empty content')
    }

    // Parse JSON from the response
    let parsed: { selected_memories?: string[] }
    try {
      parsed = JSON.parse(content) as { selected_memories?: string[] }
    } catch {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch && jsonMatch[1]) {
        parsed = JSON.parse(jsonMatch[1].trim()) as { selected_memories?: string[] }
      } else {
        throw new Error('Failed to parse JSON from LLM response')
      }
    }

    const selected = (parsed.selected_memories ?? []).filter((filename) =>
      memories.some((m) => m.filename === filename),
    )

    return {
      selected,
      fromCache: false,
      model: config.llmModel,
    }
  } catch (err) {
    if (signal?.aborted) {
      return null
    }
    // Log error but return null for graceful degradation
    if (process.env.DEBUG) {
      console.error('[llm] select memories failed:', err)
    }
    return null
  }
}

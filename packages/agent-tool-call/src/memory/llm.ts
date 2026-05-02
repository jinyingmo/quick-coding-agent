/**
 * Kimi (Moonshot AI) API client for memory relevance selection.
 *
 * Provides a side-query style interface that calls the Kimi API
 * to semantically select the most relevant memories for a user query.
 *
 * Compatible with OpenAI-style API format:
 *   POST {baseUrl}/chat/completions
 */

import type { MemoryConfig } from './config.js'
import type { MemoryHeader } from './types.js'
import { formatMemoryManifest } from './scanner.js'

export type KimiSelectResult = {
  selected: string[]
  fromCache: boolean
  model: string
}

export type KimiSelectOptions = {
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
 * Call Kimi API to select relevant memories for a query.
 *
 * @param query The user's query
 * @param memories List of available memory headers
 * @param options Config and optional signal
 * @returns Selected filenames, or null if the call failed
 */
export async function callKimiSelectMemories(
  query: string,
  memories: MemoryHeader[],
  options: KimiSelectOptions,
): Promise<KimiSelectResult | null> {
  const { config, signal, recentTools } = options

  if (!config.kimiApiKey) {
    return null
  }

  const manifest = formatMemoryManifest(memories)

  const toolsSection =
    recentTools && recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  const userContent = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`

  const requestBody = {
    model: config.kimiModel,
    messages: [
      { role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    max_tokens: 256,
  }

  const url = `${config.kimiBaseUrl}/chat/completions`

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), config.kimiTimeoutMs)

    // Link external signal if provided
    if (signal) {
      signal.addEventListener('abort', () => controller.abort())
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.kimiApiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(`Kimi API ${response.status}: ${errorText}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string }
      }>
    }

    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('Kimi API returned empty content')
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
        throw new Error('Failed to parse JSON from Kimi response')
      }
    }

    const selected = (parsed.selected_memories ?? []).filter((filename) =>
      memories.some((m) => m.filename === filename),
    )

    return {
      selected,
      fromCache: false,
      model: config.kimiModel,
    }
  } catch (err) {
    if (signal?.aborted) {
      return null
    }
    // Log error but return null for graceful degradation
    if (process.env.DEBUG) {
      console.error('[kimi] select memories failed:', err)
    }
    return null
  }
}

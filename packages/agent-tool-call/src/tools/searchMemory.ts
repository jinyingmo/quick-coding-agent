/**
 * `search_memory` — semantic / keyword search over the memory directory.
 *
 * This is the integration point with the existing memory-system demo:
 *   `findRelevantMemories(query, memoryDir, options)` is called directly,
 *   so the Kimi-powered semantic selection (or local keyword fallback) is
 *   reused without re-implementing it here.
 *
 * The result is rendered as a compact text manifest the LLM can read back —
 * the same structure the parent project uses to inject memory hits into
 * the model context (see `findRelevantMemories` in `src/memdir/`).
 */

import { z } from 'zod'
import { findRelevantMemories } from '@quick-coding-agent/memory-system'
import type { Tool } from '../types.js'

const inputSchema = z.object({
  query: z
    .string()
    .describe('Natural language query — what topic or piece of context are you looking for?'),
  /**
   * `findRelevantMemories` already caps results internally (MAX_RELEVANT = 5).
   * We expose the field so the LLM thinks in terms of "I want a few hits", but
   * the underlying retriever owns the hard cap.
   */
  max_snippet_chars: z
    .number()
    .int()
    .min(200)
    .max(4000)
    .optional()
    .describe('Maximum characters of body text per memory in the response (default 1500).'),
})

type RetrievedMemory = {
  filename: string
  snippet: string
}

export const searchMemoryTool: Tool<typeof inputSchema, { memories: RetrievedMemory[] }> = {
  name: 'search_memory',
  description:
    'Search the persistent memory directory for memories relevant to a query. Returns top matching memory files with a snippet from each. Use this BEFORE answering questions about the user, project history, or past feedback.',
  inputSchema,
  isReadOnly: () => true,
  async call(input, ctx) {
    const maxChars = input.max_snippet_chars ?? 1500
    try {
      const result = await findRelevantMemories(input.query, ctx.memoryDir, {
        signal: ctx.signal,
      })
      const memories: RetrievedMemory[] = result.memories.map(m => ({
        filename: m.filename,
        snippet: m.content.length > maxChars ? m.content.slice(0, maxChars) + '\n…(truncated)' : m.content,
      }))
      const display =
        memories.length === 0
          ? '(no relevant memories found)'
          : memories
              .map(m => `## ${m.filename}\n\n${m.snippet.trim()}`)
              .join('\n\n---\n\n')
      const mode = result.usedLLM ? `LLM (${result.model ?? 'unknown'})` : 'local keyword'
      ctx.log(
        `[search_memory] "${input.query}" → ${memories.length} hits via ${mode}`,
        'debug',
      )
      return {
        data: { memories },
        display: `Search mode: ${mode}\n\n${display}`,
      }
    } catch (err) {
      const msg = (err as Error).message
      ctx.log(`[search_memory] error: ${msg}`, 'warn')
      return {
        data: { memories: [] },
        display: `Error searching memory: ${msg}`,
        isError: true,
      }
    }
  },
}

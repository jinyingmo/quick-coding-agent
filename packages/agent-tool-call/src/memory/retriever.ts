/**
 * Memory retrieval and search.
 *
 * Two retrieval modes:
 *   1. LLM mode (default): Calls Kimi API to semantically select relevant memories
 *   2. Fallback mode: Local keyword-based relevance scoring when LLM is unavailable
 */

import { readFile } from 'fs/promises'
import type { MemoryHeader } from './types.js'
import { scanMemoryFiles, formatMemoryManifest } from './scanner.js'
import { memoryFreshnessNote } from './age.js'
import { callKimiSelectMemories } from './llm.js'
import { loadConfig, isKimiAvailable, type MemoryConfig } from './config.js'

export type RelevantMemory = {
  path: string
  filename: string
  mtimeMs: number
  content: string
}

export type RetrievalResult = {
  memories: RelevantMemory[]
  usedLLM: boolean
  model?: string
}

const MAX_RELEVANT = 5

/**
 * Find memory files relevant to a query.
 *
 * By default, attempts to use the Kimi LLM API for semantic relevance selection.
 * If the API is unavailable (no key, network error, timeout), gracefully falls
 * back to local keyword-based scoring.
 *
 * @param query The user's query
 * @param memoryDir Directory containing memory files
 * @param options Retrieval options
 * @returns Relevant memories + metadata about which engine was used
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  options: {
    /** Override default config (uses env vars if not provided) */
    config?: MemoryConfig
    /** Force disable LLM and use local scoring */
    useLLM?: boolean
    /** Abort signal for cancellation */
    signal?: AbortSignal
    /** Recently used tool names (to filter reference noise) */
    recentTools?: string[]
    /** Exclude memories already surfaced in prior turns */
    alreadySurfaced?: Set<string>
  } = {},
): Promise<RetrievalResult> {
  const {
    config = loadConfig(),
    useLLM = true,
    signal,
    recentTools,
    alreadySurfaced = new Set(),
  } = options

  const memories = (await scanMemoryFiles(memoryDir)).filter(
    (m) => !alreadySurfaced.has(m.filePath),
  )

  if (memories.length === 0) {
    return { memories: [], usedLLM: false }
  }

  // Phase 1: Try LLM selection if enabled and configured
  if (useLLM && isKimiAvailable(config)) {
    const llmResult = await callKimiSelectMemories(query, memories, {
      config,
      signal,
      recentTools,
    })

    if (llmResult) {
      const byFilename = new Map(memories.map((m) => [m.filename, m]))
      const selected = llmResult.selected
        .map((filename) => byFilename.get(filename))
        .filter((m): m is MemoryHeader => m !== undefined)

      const relevant = await loadMemoryContents(selected)
      return {
        memories: relevant,
        usedLLM: true,
        model: llmResult.model,
      }
    }

    // LLM call failed — fall through to local scoring
    if (process.env.DEBUG) {
      console.log('[retriever] LLM selection failed, falling back to local scoring')
    }
  }

  // Phase 2: Local keyword-based fallback
  const relevant = await findRelevantMemoriesLocal(query, memories)
  return { memories: relevant, usedLLM: false }
}

/**
 * Local keyword-based relevance scoring (fallback when LLM is unavailable).
 */
async function findRelevantMemoriesLocal(
  query: string,
  memories: MemoryHeader[],
): Promise<RelevantMemory[]> {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)

  if (words.length === 0) {
    return []
  }

  const scored = await Promise.all(
    memories.map(async (m) => {
      let score = 0
      const filenameLower = m.filename.toLowerCase()
      const descLower = (m.description ?? '').toLowerCase()

      for (const word of words) {
        if (filenameLower.includes(word)) score += 3
        if (descLower.includes(word)) score += 2
      }

      // Read full content for deeper scoring (only if already has some score)
      if (score > 0) {
        const content = await readFile(m.filePath, 'utf-8')
        const contentLower = content.toLowerCase()
        for (const word of words) {
          if (contentLower.includes(word)) score += 1
        }
        return { header: m, score, content }
      }

      return { header: m, score, content: '' }
    }),
  )

  const withContent = scored.filter((s) => s.score > 0 && s.content)

  return withContent
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT)
    .map((s) => ({
      path: s.header.filePath,
      filename: s.header.filename,
      mtimeMs: s.header.mtimeMs,
      content: s.content,
    }))
}

/**
 * Load full content for a list of memory headers.
 */
async function loadMemoryContents(
  memories: MemoryHeader[],
): Promise<RelevantMemory[]> {
  const results = await Promise.allSettled(
    memories.map(async (m) => {
      const content = await readFile(m.filePath, 'utf-8')
      return {
        path: m.filePath,
        filename: m.filename,
        mtimeMs: m.mtimeMs,
        content,
      }
    }),
  )

  return results
    .filter(
      (r): r is PromiseFulfilledResult<RelevantMemory> =>
        r.status === 'fulfilled',
    )
    .map((r) => r.value)
    .slice(0, MAX_RELEVANT)
}

/**
 * Format relevant memories for display, with freshness notes.
 */
export function formatRelevantMemories(memories: RelevantMemory[]): string {
  if (memories.length === 0) return 'No relevant memories found.'

  return memories
    .map((m) => {
      const freshness = memoryFreshnessNote(m.mtimeMs)
      return `${freshness}**${m.filename}** (${new Date(m.mtimeMs).toISOString()}):
\`\`\`
${m.content}
\`\`\``
    })
    .join('\n\n---\n\n')
}

export { formatMemoryManifest }

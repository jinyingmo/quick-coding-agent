/** 中文说明：内置记忆子系统。 */

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
 * 查找与查询相关的记忆文件：优先使用 Kimi LLM 语义选择，不可用时回退到本地关键字评分。
 *
 * Find memory files relevant to a query.
 *
 * By default, attempts to use the Kimi LLM API for semantic relevance selection.
 * If the API is unavailable (no key, network error, timeout), gracefully falls
 * back to local keyword-based scoring.
 *
 * @param query 用户查询文本
 * @param memoryDir 记忆文件目录
 * @param options 检索选项
 * @returns 相关记忆列表及使用的搜索引擎元数据
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
 * 使用关键字匹配进行相关性评分（LLM 不可用时的本地回退方案）。
 *
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
 * 加载一批记忆头信息对应的完整文件内容。
 *
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
 * 格式化相关记忆列表，附带新鲜度提示。
 *
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

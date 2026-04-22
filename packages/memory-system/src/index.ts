/**
 * Memory System — public API exports.
 *
 * Core modules re-exported for programmatic use:
 *   import { saveMemory, findRelevantMemories, buildMemoryPrompt } from './index.js'
 */

export { MEMORY_TYPES, parseMemoryType, isMemoryType } from './types.js'
export type { MemoryType, MemoryHeader, FrontmatterData, ParsedMarkdown } from './types.js'

export { parseFrontmatter, buildMemoryFile } from './parser.js'

export { scanMemoryFiles, formatMemoryManifest } from './scanner.js'

export {
  readEntrypoint,
  truncateEntrypointContent,
  indexMemory,
  unindexMemory,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from './indexer.js'

export { saveMemory, updateMemoryContent, deleteMemory, ensureMemoryDirExists } from './store.js'
export type { MemorySaveParams } from './store.js'

export { findRelevantMemories, formatRelevantMemories } from './retriever.js'
export type { RelevantMemory, RetrievalResult } from './retriever.js'

export { buildMemoryPrompt } from './prompts.js'

export { memoryAgeDays, memoryAge, memoryFreshnessText, memoryFreshnessNote } from './age.js'

export { loadConfig, isKimiAvailable } from './config.js'
export type { MemoryConfig } from './config.js'

export { callKimiSelectMemories } from './llm.js'
export type { KimiSelectResult, KimiSelectOptions } from './llm.js'

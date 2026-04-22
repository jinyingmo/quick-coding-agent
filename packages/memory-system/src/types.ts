/**
 * Memory type taxonomy — the four discrete types of memory.
 *
 * Memories capture context NOT derivable from the current project state.
 * Code patterns, architecture, git history, and file structure are derivable
 * and should NOT be saved as memories.
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export function isMemoryType(raw: unknown): raw is MemoryType {
  return typeof raw === 'string' && MEMORY_TYPES.includes(raw as MemoryType)
}

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}

/**
 * Represents a scanned memory file header (metadata only, not full content).
 */
export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

/**
 * Parsed frontmatter from a markdown memory file.
 */
export type FrontmatterData = {
  name?: string | null
  description?: string | null
  type?: string | null
  [key: string]: unknown
}

/**
 * Result of parsing a markdown file with frontmatter.
 */
export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
}

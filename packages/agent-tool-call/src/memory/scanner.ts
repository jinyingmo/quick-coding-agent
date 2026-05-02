/** 中文说明：内置记忆子系统。 */

/**
 * Memory directory scanning primitives.
 *
 * Scans a memory directory for .md files, reads their frontmatter,
 * and returns a header list sorted newest-first.
 */

import { readdir, stat, readFile } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from './parser.js'
import type { MemoryHeader } from './types.js'
import { parseMemoryType } from './types.js'

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/** 扫描记忆目录中所有 .md 文件，解析 frontmatter 并返回按修改时间降序的头信息列表 */
export async function scanMemoryFiles(memoryDir: string): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      (f) => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const stats = await stat(filePath)
        const content = await readFile(filePath, 'utf-8')
        // Read only the first N lines for frontmatter parsing
        const lines = content.split('\n')
        const head = lines.slice(0, FRONTMATTER_MAX_LINES).join('\n')
        const { frontmatter } = parseFrontmatter(head)

        return {
          filename: relativePath,
          filePath,
          mtimeMs: stats.mtimeMs,
          description: (frontmatter.description as string) || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * 将记忆头列表格式化为文本清单，每行一个文件。
 *
 * Format memory headers as a text manifest: one line per file.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}

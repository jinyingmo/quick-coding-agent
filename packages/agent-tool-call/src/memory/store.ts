/** 中文说明：内置记忆子系统。 */

/**
 * Memory storage core.
 *
 * Handles creating, updating, and deleting memory files,
 * keeping the MEMORY.md index in sync.
 */

import { writeFile, readFile, unlink, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { buildMemoryFile, parseFrontmatter } from './parser.js'
import { indexMemory, unindexMemory } from './indexer.js'
import type { MemoryType } from './types.js'

export type MemorySaveParams = {
  memoryDir: string
  filename: string
  name: string
  description: string
  type: MemoryType
  content: string
  hook?: string
}

/**
 * 保存新的记忆文件（或覆盖已有文件），自动更新 MEMORY.md 索引。
 *
 * Save a new memory file (or overwrite an existing one).
 * Automatically updates MEMORY.md index.
 */
export async function saveMemory(params: MemorySaveParams): Promise<void> {
  const { memoryDir, filename, name, description, type, content, hook } = params

  const filePath = join(memoryDir, filename)
  await mkdir(dirname(filePath), { recursive: true })

  const markdown = buildMemoryFile({ name, description, type, content })
  await writeFile(filePath, markdown, 'utf-8')

  // Update index
  await indexMemory(memoryDir, filename, name, hook ?? description)
}

/**
 * 更新已有记忆文件的正文内容，保留 frontmatter 不变。
 *
 * Update the body content of an existing memory file, preserving frontmatter.
 */
export async function updateMemoryContent(
  memoryDir: string,
  filename: string,
  newContent: string,
): Promise<void> {
  const filePath = join(memoryDir, filename)
  const existing = await readFile(filePath, 'utf-8')
  const { frontmatter } = parseFrontmatter(existing)

  const markdown = buildMemoryFile({
    name: (frontmatter.name as string) ?? filename.replace('.md', ''),
    description: (frontmatter.description as string) ?? '',
    type: (frontmatter.type as string) ?? 'project',
    content: newContent,
  })

  await writeFile(filePath, markdown, 'utf-8')
}

/**
 * 删除记忆文件并从索引中移除。
 *
 * Delete a memory file and remove it from the index.
 */
export async function deleteMemory(
  memoryDir: string,
  filename: string,
): Promise<void> {
  const filePath = join(memoryDir, filename)
  await unlink(filePath)
  await unindexMemory(memoryDir, filename)
}

/**
 * 确保记忆目录存在，必要时递归创建。
 *
 * Ensure the memory directory exists.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true })
}

/** 中文说明：内置记忆子系统。 */

/**
 * MEMORY.md index management.
 *
 * MEMORY.md is a concise index (not a memory itself).
 * Each entry: `- [Title](file.md) — one-line hook`
 * No frontmatter. Lines after 200 are truncated.
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasTruncated: boolean
}

/**
 * 按行数和字节数上限截断 MEMORY.md 内容。
 *
 * Truncate MEMORY.md content to line AND byte caps.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const lineCount = lines.length
  const byteCount = Buffer.byteLength(trimmed, 'utf8')

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasTruncated: false }
  }

  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (Buffer.byteLength(truncated, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    // Walk back from byte limit to last newline
    let bytes = 0
    let cutIndex = truncated.length
    for (let i = 0; i < truncated.length; i++) {
      const charBytes = Buffer.byteLength(truncated[i], 'utf8')
      if (bytes + charBytes > MAX_ENTRYPOINT_BYTES) {
        const lastNewline = truncated.lastIndexOf('\n', i)
        cutIndex = lastNewline > 0 ? lastNewline : i
        break
      }
      bytes += charBytes
    }
    truncated = truncated.slice(0, cutIndex)
  }

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} truncated. Keep index entries concise (one line under ~150 chars).`,
    lineCount,
    byteCount,
    wasTruncated: true,
  }
}

/**
 * 从记忆目录读取 MEMORY.md 入口文件，自动截断超限内容。
 *
 * Read the MEMORY.md entrypoint from a memory directory.
 */
export async function readEntrypoint(memoryDir: string): Promise<string> {
  try {
    const content = await readFile(join(memoryDir, ENTRYPOINT_NAME), 'utf-8')
    const t = truncateEntrypointContent(content)
    return t.content
  } catch {
    return ''
  }
}

/**
 * 在 MEMORY.md 中添加记忆文件指针，若已索引则更新对应的行。
 *
 * Add a pointer to a memory file in MEMORY.md.
 * If the file is already indexed, updates its hook line.
 */
export async function indexMemory(
  memoryDir: string,
  filename: string,
  title: string,
  hook: string,
): Promise<void> {
  const entrypointPath = join(memoryDir, ENTRYPOINT_NAME)
  let content = ''
  try {
    content = await readFile(entrypointPath, 'utf-8')
  } catch {
    // doesn't exist yet
  }

  const lines = content.split('\n')
  const linkPattern = new RegExp(`^- \\[(.*?)\\]\\(${filename}\\) —`)

  const existingIndex = lines.findIndex((line) => linkPattern.test(line))
  const newLine = `- [${title}](${filename}) — ${hook}`

  if (existingIndex >= 0) {
    lines[existingIndex] = newLine
  } else {
    lines.push(newLine)
  }

  await writeFile(entrypointPath, lines.join('\n') + '\n', 'utf-8')
}

/**
 * 从 MEMORY.md 中移除指定记忆文件的引用行。
 *
 * Remove a memory file reference from MEMORY.md.
 */
export async function unindexMemory(
  memoryDir: string,
  filename: string,
): Promise<void> {
  const entrypointPath = join(memoryDir, ENTRYPOINT_NAME)
  let content = ''
  try {
    content = await readFile(entrypointPath, 'utf-8')
  } catch {
    return
  }

  const lines = content.split('\n')
  const linkPattern = new RegExp(`^- \\[(.*?)\\]\\(${filename}\\) —`)
  const filtered = lines.filter((line) => !linkPattern.test(line))

  await writeFile(entrypointPath, filtered.join('\n') + '\n', 'utf-8')
}

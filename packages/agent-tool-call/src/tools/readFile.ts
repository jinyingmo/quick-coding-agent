/** 中文说明：工具层模块。 */

/**
 * `read_file` — read a UTF-8 text file from disk.
 *
 * Mirrors the spirit of `FileReadTool` in the parent project: trimmed to the
 * essentials (no offset/limit, no image handling), but keeps the same shape:
 * a Zod-typed Tool, with isReadOnly = true so the extractor's restricted
 * permission set can allow it unconditionally.
 *
 * 中文说明：read_file 工具，从磁盘读取 UTF-8 文本文件，纯只读操作。
 */

import { readFile, stat } from 'fs/promises'
import { z } from 'zod'
import type { Tool } from '../types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read.'),
})

export const readFileTool: Tool<typeof inputSchema, { content: string; bytes: number }> = {
  name: 'read_file',
  description:
    'Read the contents of a UTF-8 text file. Use this before editing a file or before recommending information from a memory file.',
  inputSchema,
  /** 始终返回 true，仅读取文件内容，无副作用。 */
  isReadOnly: () => true,
  /** 读取文件内容，先检查是否为普通文件，读取后返回内容与字节数。 */
  async call(input, ctx) {
    try {
      const stats = await stat(input.file_path)
      if (!stats.isFile()) {
        return {
          data: { content: '', bytes: 0 },
          display: `Path is not a regular file: ${input.file_path}`,
          isError: true,
        }
      }
      const content = await readFile(input.file_path, 'utf-8')
      ctx.log(`[read_file] ${input.file_path} (${content.length} chars)`, 'debug')
      return {
        data: { content, bytes: content.length },
        display: content,
      }
    } catch (err) {
      const msg = (err as Error).message
      ctx.log(`[read_file] error reading ${input.file_path}: ${msg}`, 'warn')
      return {
        data: { content: '', bytes: 0 },
        display: `Error reading ${input.file_path}: ${msg}`,
        isError: true,
      }
    }
  },
}

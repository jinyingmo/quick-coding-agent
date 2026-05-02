/** 中文说明：工具层模块。 */

/**
 * `list_dir` — list immediate children of a directory.
 *
 * Mirrors `LsTool` / `GlobTool` from the parent project at the simplest level:
 * just enumerate one directory level and return file/dir markers. Read-only.
 *
 * 中文说明：list_dir 工具，列出目录的直接子项，返回文件/目录标记，只读操作。
 */

import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import type { Tool } from '../types.js'

// 单次列目录上限：500 条。超大目录截断并提示，防止撑爆上下文。
const MAX_ENTRIES = 500

const inputSchema = z.object({
  dir_path: z.string().describe('Absolute directory path to list.'),
})

type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

export const listDirTool: Tool<typeof inputSchema, { entries: Entry[] }> = {
  name: 'list_dir',
  description:
    'List the immediate contents of a directory. Returns one entry per line, prefixed with [d] for directories and [f] for regular files.',
  inputSchema,
  /** 始终返回 true，仅读取目录结构，无副作用。 */
  isReadOnly: () => true,
  /** 读取目录内容，获取每个条目的类型（目录/文件/其他），排序后返回。 */
  async call(input, ctx) {
    try {
      const names = await readdir(input.dir_path)
      const entries = await Promise.all(
        // 并发获取每个目录条目的 stat 信息，判断类型（目录/文件/其他）。
        names.map(async (name): Promise<Entry> => {
          try {
            const s = await stat(join(input.dir_path, name))
            return { name, kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other' }
          } catch {
            return { name, kind: 'other' }
          }
        }),
      )
      entries.sort((a, b) => a.name.localeCompare(b.name))
      const truncated = entries.length > MAX_ENTRIES
      const visible = truncated ? entries.slice(0, MAX_ENTRIES) : entries
      let display = visible
        .map(e => `${e.kind === 'dir' ? '[d]' : e.kind === 'file' ? '[f]' : '[?]'} ${e.name}`)
        .join('\n')
      if (truncated) display += `\n\n[Output truncated at ${MAX_ENTRIES} entries (${entries.length} total). Use glob or a more specific path.]`
      ctx.log(`[list_dir] ${input.dir_path} (${entries.length} entries${truncated ? ', truncated' : ''})`, 'debug')
      return {
        data: { entries: visible },
        display: display || '(empty directory)',
      }
    } catch (err) {
      const msg = (err as Error).message
      ctx.log(`[list_dir] error reading ${input.dir_path}: ${msg}`, 'warn')
      return {
        data: { entries: [] },
        display: `Error listing ${input.dir_path}: ${msg}`,
        isError: true,
      }
    }
  },
}

/**
 * `list_dir` — list immediate children of a directory.
 *
 * Mirrors `LsTool` / `GlobTool` from the parent project at the simplest level:
 * just enumerate one directory level and return file/dir markers. Read-only.
 */

import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import type { Tool } from '../types.js'

const inputSchema = z.object({
  dir_path: z.string().describe('Absolute directory path to list.'),
})

type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

export const listDirTool: Tool<typeof inputSchema, { entries: Entry[] }> = {
  name: 'list_dir',
  description:
    'List the immediate contents of a directory. Returns one entry per line, prefixed with [d] for directories and [f] for regular files.',
  inputSchema,
  isReadOnly: () => true,
  async call(input, ctx) {
    try {
      const names = await readdir(input.dir_path)
      const entries = await Promise.all(
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
      const display = entries
        .map(e => `${e.kind === 'dir' ? '[d]' : e.kind === 'file' ? '[f]' : '[?]'} ${e.name}`)
        .join('\n')
      ctx.log(`[list_dir] ${input.dir_path} (${entries.length} entries)`, 'debug')
      return {
        data: { entries },
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

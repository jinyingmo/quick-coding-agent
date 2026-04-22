/**
 * `write_file` — write a UTF-8 text file (creating parent dirs).
 *
 * Mirrors `FileWriteTool` in the parent project. `isReadOnly` is `false` —
 * this is the gate the extractor's CanUseToolFn uses to enforce that writes
 * only happen inside the auto-memory directory.
 */

import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import type { Tool } from '../types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to write.'),
  content: z.string().describe('The full file contents to write.'),
})

export const writeFileTool: Tool<typeof inputSchema, { bytesWritten: number }> = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file. Parent directories are created automatically. Use this to save a memory: write a topic file (e.g. user_role.md) AND update MEMORY.md afterwards.',
  inputSchema,
  isReadOnly: () => false,
  async call(input, ctx) {
    try {
      await mkdir(dirname(input.file_path), { recursive: true })
      await writeFile(input.file_path, input.content, 'utf-8')
      ctx.log(`[write_file] ${input.file_path} (${input.content.length} chars)`, 'info')
      return {
        data: { bytesWritten: input.content.length },
        display: `Wrote ${input.content.length} chars to ${input.file_path}`,
      }
    } catch (err) {
      const msg = (err as Error).message
      ctx.log(`[write_file] error writing ${input.file_path}: ${msg}`, 'error')
      return {
        data: { bytesWritten: 0 },
        display: `Error writing ${input.file_path}: ${msg}`,
        isError: true,
      }
    }
  },
}

/** 中文说明：工具层模块。 */

/**
 * `edit_file` — precise find-and-replace editing.
 *
 * Mirrors the core behaviour of `FileEditTool` (Edit) from the parent project:
 * instead of overwriting the whole file, the agent supplies the exact string to
 * replace (`old_string`) and the replacement (`new_string`).  This keeps diffs
 * small and makes it easy for the model to reason about what changed.
 *
 * Guard-rails (mirrors the parent project's validateInput logic):
 *  - File must exist and must have been read first (we check readFileState is
 *    not needed here since we're simplified, but we do verify the file exists).
 *  - `old_string` must appear exactly once in the file content; if there are
 *    multiple occurrences the tool returns an error asking for more context.
 *  - `old_string === new_string` is rejected early.
 *
 * 中文说明：edit_file 工具，通过精确查找替换（old_string → new_string）来编辑文件，保证差异最小化。
 */

import { readFile, writeFile } from 'fs/promises'
import { z } from 'zod'
import type { Tool } from '../types.js'

const inputSchema = z.object({
  file_path: z
    .string()
    .describe('Absolute path to the file to edit. The file must already exist.'),
  old_string: z
    .string()
    .describe(
      'The exact string to find and replace. Must match the file content byte-for-byte ' +
        '(including whitespace and line endings). Read the file first to get the exact text.',
    ),
  new_string: z
    .string()
    .describe(
      'The replacement string. Use an empty string to delete old_string from the file.',
    ),
})

type Output = { replaced: boolean; occurrencesFound: number }

export const editFileTool: Tool<typeof inputSchema, Output> = {
  name: 'edit_file',
  description:
    'Edit a file by replacing one exact occurrence of old_string with new_string. ' +
    'You MUST call read_file first so you know the exact current content. ' +
    'old_string must appear exactly once — provide enough surrounding context (blank ' +
    'lines, function signature, etc.) to make it unique. ' +
    'For new files or complete rewrites, use write_file instead. ' +
    'For Jupyter notebooks, use bash with the nbformat CLI.',
  inputSchema,
  /** 始终返回 false，编辑操作会写入文件系统。 */
  isReadOnly: () => false,
  /** 读取文件内容，查找 old_string（必须唯一匹配），替换后写回文件。 */
  async call(input, ctx) {
    const { file_path, old_string, new_string } = input

    if (old_string === new_string) {
      return {
        data: { replaced: false, occurrencesFound: 0 },
        display: 'No-op: old_string and new_string are identical.',
        isError: true,
      }
    }

    let content: string
    try {
      content = await readFile(file_path, 'utf-8')
    } catch (err) {
      return {
        data: { replaced: false, occurrencesFound: 0 },
        display: `Cannot read ${file_path}: ${(err as Error).message}`,
        isError: true,
      }
    }

    // Count occurrences
    const parts = content.split(old_string)
    const occurrencesFound = parts.length - 1

    if (occurrencesFound === 0) {
      return {
        data: { replaced: false, occurrencesFound: 0 },
        display:
          `String not found in ${file_path}.\n` +
          `Searched for: ${old_string.slice(0, 120)}${old_string.length > 120 ? '…' : ''}`,
        isError: true,
      }
    }

    if (occurrencesFound > 1) {
      return {
        data: { replaced: false, occurrencesFound },
        display:
          `Found ${occurrencesFound} occurrences of old_string in ${file_path}. ` +
          'Provide more surrounding context in old_string to uniquely identify the instance you want to change.',
        isError: true,
      }
    }

    // Exactly one match — replace and write
    const updated = content.replace(old_string, new_string)
    try {
      await writeFile(file_path, updated, 'utf-8')
    } catch (err) {
      return {
        data: { replaced: false, occurrencesFound: 1 },
        display: `Error writing ${file_path}: ${(err as Error).message}`,
        isError: true,
      }
    }

    ctx.log(`[edit_file] updated ${file_path}`, 'info')
    return {
      data: { replaced: true, occurrencesFound: 1 },
      display: `File updated successfully: ${file_path}`,
    }
  },
}

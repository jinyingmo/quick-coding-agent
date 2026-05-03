/** 中文说明：工具层模块。 */

/**
 * `grep` — search file contents with a regular expression.
 *
 * Mirrors the behaviour of `GrepTool` (which uses ripgrep) from the parent
 * project, but implemented entirely in Node.js so there is no dependency on
 * the `rg` binary.  Trade-offs relative to ripgrep:
 *
 *  - Slower on very large repos (no mmap, no parallelism).
 *  - Uses a lightweight .gitignore / .ignore matcher instead of Git's full ruleset.
 *  - Hard limit of 200 matching lines prevents context overflow.
 *
 * The same "always skip" set used by GlobTool is applied here.
 *
 * Output modes:
 *  - "content"  (default) — "file:lineNum: text" for each matching line
 *  - "files"    — just the list of files that contain at least one match
 *
 * 中文说明：grep 工具，用正则表达式搜索文件内容，纯 Node.js 实现，最多返回 200 条匹配行，自动跳过大型目录。
 */

import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import type { Tool } from '../types.js'
import {
  ALWAYS_SKIP,
  DEFAULT_TRAVERSAL_CONCURRENCY,
  createConcurrencyLimiter,
  createIgnoreMatcher,
  mapWithConcurrencyLimit,
  type ConcurrencyLimiter,
  type IgnoreMatcher,
} from './fsTraversal.js'

type Match = { file: string; line: number; text: string }

// ────────────────────────────────────────────────────────────────────────────
// Scanning helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Search a single file for `pattern`.  Appends up to `limit` matches.
 * Returns true if the file produced at least one match (for files-only mode).
 *
 * 中文说明：在单个文件中搜索正则匹配，将匹配行追加到 matches 数组，达到 limit 后停止。返回是否至少有一个匹配。
 */
async function grepFile(
  filePath: string,
  pattern: RegExp,
  matches: Match[],
  limit: number,
  limiter: ConcurrencyLimiter,
): Promise<boolean> {
  if (matches.length >= limit) return false

  let text: string
  try {
    text = await limiter.run(() => readFile(filePath, 'utf-8'))
  } catch {
    return false // binary or unreadable — skip silently
  }

  // Quick check before splitting lines
  if (!pattern.test(text)) return false

  let found = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= limit) break
    if (pattern.test(lines[i]!)) {
      matches.push({ file: filePath, line: i + 1, text: lines[i]! })
      found = true
    }
  }
  return found
}

/**
 * Recursively search a directory, collecting matches.
 * `globExt` is an optional extension filter (e.g. "ts" from "*.ts").
 *
 * 中文说明：递归搜索目录收集匹配，globExt 为可选的文件扩展名过滤（如 "ts" 来自 "*.ts"）。
 */
async function grepDir(
  dir: string,
  pattern: RegExp,
  globExt: string | undefined,
  matches: Match[],
  limit: number,
  ignoreMatcher: IgnoreMatcher,
  limiter: ConcurrencyLimiter,
): Promise<void> {
  if (matches.length >= limit) return

  let names: string[]
  try {
    names = await limiter.run(() => readdir(dir))
  } catch {
    return
  }
  names.sort()

  await mapWithConcurrencyLimit(
    names,
    DEFAULT_TRAVERSAL_CONCURRENCY,
    async name => {
      if (matches.length >= limit) return
      if (ALWAYS_SKIP.has(name)) return

      const fullPath = join(dir, name)
      let s
      try {
        s = await limiter.run(() => stat(fullPath))
      } catch {
        return
      }

      if (s.isDirectory()) {
        if (await ignoreMatcher.shouldIgnore(fullPath, 'dir')) return
        await grepDir(
          fullPath,
          pattern,
          globExt,
          matches,
          limit,
          ignoreMatcher,
          limiter,
        )
      } else if (s.isFile()) {
        if (await ignoreMatcher.shouldIgnore(fullPath, 'file')) return
        // Extension filter (from glob parameter)
        if (globExt) {
          const ext = name.includes('.') ? name.split('.').pop() : ''
          if (ext !== globExt) return
        }
        await grepFile(fullPath, pattern, matches, limit, limiter)
      }
    },
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definition
// ────────────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  pattern: z
    .string()
    .describe('Regular expression to search for. JavaScript regex syntax.'),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to a file or directory to search. Defaults to the agent working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'File-extension filter, e.g. "*.ts" or "*.py". ' +
        'Only files with that extension are searched. Leave empty to search all text files.',
    ),
  case_insensitive: z
    .boolean()
    .optional()
    .describe('If true, the regex is compiled case-insensitively (default: false).'),
  output_mode: z
    .enum(['content', 'files'])
    .optional()
    .describe(
      '"content" (default) shows file:line: text for each match. ' +
        '"files" returns only the list of matching files.',
    ),
})

type Output = {
  matches: Match[]
  filesMatched: string[]
  count: number
  truncated: boolean
}

export const grepTool: Tool<typeof inputSchema, Output> = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. ' +
    'Returns up to 200 matching lines with file path and line number. ' +
    'Use glob to filter by file type (e.g. "*.ts"). ' +
    'Use output_mode="files" to get only the list of matching file paths. ' +
    'Automatically excludes node_modules, .git, dist, build, coverage. ' +
    'Respects .gitignore and .ignore files while traversing directories. ' +
    'ALWAYS use this tool for text searches — never invoke grep or rg via bash.',
  inputSchema,
  /** 始终返回 true，此工具仅读取文件内容，不产生副作用。 */
  isReadOnly: () => true,
  /** 构造正则表达式，遍历指定路径的文件/目录，收集匹配行或文件列表。 */
  async call(input, ctx) {
    const LIMIT = 200
    const searchPath = input.path ?? ctx.cwd
    const outputMode = input.output_mode ?? 'content'

    // Build regex
    const flags = input.case_insensitive ? 'i' : ''
    let pattern: RegExp
    try {
      pattern = new RegExp(input.pattern, flags)
    } catch (err) {
      return {
        data: { matches: [], filesMatched: [], count: 0, truncated: false },
        display: `Invalid regex: ${(err as Error).message}`,
        isError: true,
      }
    }

    // Extract extension from glob filter (e.g. "*.ts" → "ts")
    const globExt = input.glob
      ? input.glob.replace(/^.*\*\./, '').replace(/[^a-zA-Z0-9].*$/, '') || undefined
      : undefined

    const limiter = createConcurrencyLimiter(DEFAULT_TRAVERSAL_CONCURRENCY)
    const ignoreMatcher = createIgnoreMatcher(searchPath, limiter)
    const matches: Match[] = []

    let s
    try {
      s = await stat(searchPath)
    } catch {
      return {
        data: { matches: [], filesMatched: [], count: 0, truncated: false },
        display: `Path not found: ${searchPath}`,
        isError: true,
      }
    }

    if (s.isFile()) {
      await grepFile(searchPath, pattern, matches, LIMIT, limiter)
    } else {
      await grepDir(
        searchPath,
        pattern,
        globExt,
        matches,
        LIMIT,
        ignoreMatcher,
        limiter,
      )
    }

    matches.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file)
      return a.line - b.line
    })

    const truncated = matches.length >= LIMIT
    const filesMatched = [...new Set(matches.map(m => m.file))]

    let display: string
    if (matches.length === 0) {
      display = 'No matches found'
    } else if (outputMode === 'files') {
      display =
        filesMatched.join('\n') +
        (truncated ? '\n\n(Results truncated at 200 matches — use a more specific pattern.)' : '')
    } else {
      display =
        matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n') +
        (truncated ? '\n\n(Results truncated at 200 matches — use a more specific pattern.)' : '')
    }

    ctx.log(
      `[grep] pattern=${input.pattern} → ${matches.length} matches in ${filesMatched.length} files`,
      'debug',
    )
    return {
      data: { matches, filesMatched, count: matches.length, truncated },
      display,
    }
  },
}

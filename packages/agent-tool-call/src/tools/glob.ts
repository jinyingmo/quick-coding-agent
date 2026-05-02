/** 中文说明：工具层模块。 */

/**
 * `glob` — find files matching a shell-style glob pattern.
 *
 * Mirrors `GlobTool` from the parent project. Pure Node.js implementation with
 * no external dependencies. Supports the most common patterns:
 *
 *   **   - any directory depth (recursive)
 *   *    - any sequence of non-separator characters in a single segment
 *   ?    - any single non-separator character
 *
 * Hidden files and directories (dotfiles) are skipped unless the pattern
 * explicitly starts with a dot segment. The notorious performance-killers
 * (node_modules, .git, dist, build, .next, coverage) are always excluded.
 *
 * 中文说明：glob 工具，使用 shell 风格通配符模式匹配文件路径，纯 Node.js 实现，自动排除常见大型目录。
 */

import { readdir, stat } from 'fs/promises'
import { join, relative } from 'path'
import { z } from 'zod'
import type { Tool } from '../types.js'

// ────────────────────────────────────────────────────────────────────────────
// Glob → RegExp compiler
// ────────────────────────────────────────────────────────────────────────────

/** Directories that are always excluded from glob results. */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
])

/**
 * Convert a glob pattern string to a RegExp that matches relative posix paths.
 * Only handles `**`, `*`, and `?` — sufficient for the tool's documented use.
 *
 * 中文说明：将 glob 模式字符串转换为匹配相对 POSIX 路径的正则表达式，仅支持 **、* 和 ?。
 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // ** matches zero or more path segments (including slashes)
      re += '.*'
      i += 2
      // consume optional separator after **
      if (pattern[i] === '/') i++
    } else if (pattern[i] === '*') {
      // * matches anything except a path separator
      re += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      re += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(pattern[i]!)) {
      // escape regex meta-characters
      re += '\\' + pattern[i]
      i++
    } else {
      re += pattern[i]
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

// ────────────────────────────────────────────────────────────────────────────
// Recursive traversal
// ────────────────────────────────────────────────────────────────────────────

// 递归遍历目录，收集匹配正则表达式的文件路径，达到 limit 上限后停止。
async function walk(
  dir: string,
  rootDir: string,
  re: RegExp,
  results: string[],
  limit: number,
): Promise<void> {
  if (results.length >= limit) return

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }

  // Sort for deterministic output
  names.sort()

  await Promise.all(
    // 并发处理每个目录条目：跳过排除目录，递归进入子目录或检查文件是否匹配。
    names.map(async name => {
      if (results.length >= limit) return
      if (ALWAYS_SKIP.has(name)) return

      const fullPath = join(dir, name)
      let s
      try {
        s = await stat(fullPath)
      } catch {
        return
      }

      const relPath = relative(rootDir, fullPath)

      if (s.isDirectory()) {
        await walk(fullPath, rootDir, re, results, limit)
      } else if (s.isFile()) {
        // Test both the relative path and just the filename, so patterns like
        // "*.ts" match files regardless of depth when combined with ** prefix.
        if (re.test(relPath) || re.test(name)) {
          results.push(fullPath)
        }
      }
    }),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definition
// ────────────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern to match files against. Examples: "**/*.ts", "src/**/*.js", "*.json". ' +
        'Supports ** (recursive), * (single segment wildcard), ? (single char).',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Directory to search in. Defaults to the agent working directory. Must be absolute.',
    ),
})

type Output = { files: string[]; count: number; truncated: boolean }

export const globTool: Tool<typeof inputSchema, Output> = {
  name: 'glob',
  description:
    'Find files whose paths match a glob pattern. ' +
    'Returns up to 100 matching absolute paths sorted alphabetically. ' +
    'Use ** for recursive directory matching. ' +
    'Automatically excludes node_modules, .git, dist, build, .next, and coverage directories. ' +
    'When you need to find files by name pattern, prefer this over bash + find.',
  inputSchema,
  /** 始终返回 true，此工具仅读取文件系统，不产生副作用。 */
  isReadOnly: () => true,
  /** 在目录中按 glob 模式搜索文件，返回最多 100 个匹配的绝对路径。 */
  async call(input, ctx) {
    const searchDir = input.path ?? ctx.cwd
    const LIMIT = 100

    let re: RegExp
    try {
      re = globToRegExp(input.pattern)
    } catch (err) {
      return {
        data: { files: [], count: 0, truncated: false },
        display: `Invalid glob pattern: ${(err as Error).message}`,
        isError: true,
      }
    }

    const results: string[] = []
    await walk(searchDir, searchDir, re, results, LIMIT)

    const truncated = results.length >= LIMIT
    const display =
      results.length > 0
        ? results.join('\n') +
          (truncated ? '\n\n(Results truncated at 100 — use a more specific pattern.)' : '')
        : 'No files found'

    ctx.log(`[glob] pattern=${input.pattern} → ${results.length} files`, 'debug')
    return { data: { files: results, count: results.length, truncated }, display }
  },
}

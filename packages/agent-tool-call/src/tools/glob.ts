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
  isReadOnly: () => true,
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

import { readFile } from 'fs/promises'
import { dirname, relative, resolve, sep } from 'path'

export const ALWAYS_SKIP = new Set([
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

const IGNORE_FILE_NAMES = ['.gitignore', '.ignore']

export const DEFAULT_TRAVERSAL_CONCURRENCY = 16

type IgnoreRule = {
  baseDir: string
  negated: boolean
  dirOnly: boolean
  matchBasename: boolean
  matcher: RegExp
}

export type IgnoreMatcher = {
  shouldIgnore(absPath: string, kind: 'file' | 'dir'): Promise<boolean>
}

export type ConcurrencyLimiter = {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function toPosixPath(value: string): string {
  return value.split(sep).join('/')
}

export function createConcurrencyLimiter(
  limit = DEFAULT_TRAVERSAL_CONCURRENCY,
): ConcurrencyLimiter {
  let active = 0
  const queue: Array<() => void> = []

  async function waitForTurn(): Promise<void> {
    if (active < limit) return
    await new Promise<void>(resolve => {
      queue.push(resolve)
    })
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await waitForTurn()
      active++
      try {
        return await task()
      } finally {
        active--
        const next = queue.shift()
        if (next) next()
      }
    },
  }
}

export async function mapWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex++
        if (currentIndex >= items.length) return
        await worker(items[currentIndex]!, currentIndex)
      }
    }),
  )
}

export function globPatternToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 2
      if (pattern[i] === '/') i++
    } else if (pattern[i] === '*') {
      re += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      re += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(pattern[i]!)) {
      re += '\\' + pattern[i]
      i++
    } else {
      re += pattern[i]
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

function parseIgnoreLine(line: string, baseDir: string): IgnoreRule | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined

  const negated = trimmed.startsWith('!')
  let pattern = negated ? trimmed.slice(1) : trimmed
  if (!pattern) return undefined

  const dirOnly = pattern.endsWith('/')
  if (dirOnly) {
    pattern = pattern.slice(0, -1)
  }

  if (pattern.startsWith('./')) {
    pattern = pattern.slice(2)
  }

  const anchored = pattern.startsWith('/')
  if (anchored) {
    pattern = pattern.slice(1)
  }

  const normalized = toPosixPath(pattern)
  if (!normalized) return undefined

  return {
    baseDir,
    negated,
    dirOnly,
    matchBasename: !normalized.includes('/'),
    matcher: globPatternToRegExp(normalized),
  }
}

function buildAncestorDirs(rootDir: string, absPath: string): string[] {
  const normalizedRoot = resolve(rootDir)
  const normalizedPath = resolve(absPath)
  const out: string[] = []

  let current = dirname(normalizedPath)
  while (true) {
    out.push(current)
    if (current === normalizedRoot) break
    const parent = dirname(current)
    if (parent === current || !current.startsWith(normalizedRoot + sep)) break
    current = parent
  }

  return out.reverse()
}

export function createIgnoreMatcher(
  rootDir: string,
  limiter: ConcurrencyLimiter,
): IgnoreMatcher {
  const normalizedRoot = resolve(rootDir)
  const cache = new Map<string, Promise<IgnoreRule[]>>()

  async function loadRules(dir: string): Promise<IgnoreRule[]> {
    const normalizedDir = resolve(dir)
    const cached = cache.get(normalizedDir)
    if (cached) return cached

    const promise = (async () => {
      const rules: IgnoreRule[] = []
      for (const fileName of IGNORE_FILE_NAMES) {
        const filePath = resolve(normalizedDir, fileName)
        let raw: string
        try {
          raw = await limiter.run(() => readFile(filePath, 'utf-8'))
        } catch {
          continue
        }

        for (const line of raw.split(/\r?\n/)) {
          const rule = parseIgnoreLine(line, normalizedDir)
          if (rule) rules.push(rule)
        }
      }
      return rules
    })()

    cache.set(normalizedDir, promise)
    return promise
  }

  return {
    async shouldIgnore(absPath: string, kind: 'file' | 'dir'): Promise<boolean> {
      const normalizedPath = resolve(absPath)
      const relToRoot = relative(normalizedRoot, normalizedPath)

      if (!relToRoot || relToRoot.startsWith('..')) return false

      const ancestorDirs = buildAncestorDirs(normalizedRoot, normalizedPath)
      let ignored = false

      for (const baseDir of ancestorDirs) {
        const relToBase = toPosixPath(relative(baseDir, normalizedPath))
        if (!relToBase || relToBase.startsWith('../')) continue

        const segments = relToBase.split('/').filter(Boolean)
        const rules = await loadRules(baseDir)

        for (const rule of rules) {
          if (rule.dirOnly && kind !== 'dir') continue

          const matched = rule.matchBasename
            ? segments.some(segment => rule.matcher.test(segment))
            : rule.matcher.test(relToBase)

          if (matched) {
            ignored = !rule.negated
          }
        }
      }

      return ignored
    },
  }
}

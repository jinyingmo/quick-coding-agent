/**
 * Frontmatter parser for markdown memory files.
 *
 * Extracts YAML-like frontmatter between `---` delimiters.
 * Uses a minimal inline YAML parser to avoid external dependencies.
 */

import type { FrontmatterData, ParsedMarkdown } from './types.js'

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * Minimal YAML parser that handles the subset used in memory frontmatter:
 * - key: value pairs (one per line)
 * - Supports quoted strings with " and '
 * - Supports unquoted strings
 * - Skips blank lines
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split('\n')

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.slice(0, colonIndex).trim()
    let value = line.slice(colonIndex + 1).trim()

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")
    }

    result[key] = value
  }

  return result
}

/**
 * Parse markdown content to extract frontmatter and body.
 */
export function parseFrontmatter(markdown: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX)

  if (!match) {
    return { frontmatter: {}, content: markdown }
  }

  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let frontmatter: FrontmatterData = {}
  try {
    const parsed = parseSimpleYaml(frontmatterText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as FrontmatterData
    }
  } catch {
    // parsing failed — return empty frontmatter
  }

  return { frontmatter, content }
}

/**
 * Build a memory file from frontmatter fields and body content.
 */
export function buildMemoryFile(params: {
  name: string
  description: string
  type: string
  content: string
}): string {
  return `---
name: ${escapeYamlValue(params.name)}
description: ${escapeYamlValue(params.description)}
type: ${params.type}
---

${params.content}
`
}

function escapeYamlValue(value: string): string {
  const needsQuotes = /[":#{}[\]|>&@`]/.test(value) || value.startsWith(' ') || value.endsWith(' ')
  if (needsQuotes) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

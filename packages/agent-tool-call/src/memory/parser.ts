/** 中文说明：内置记忆子系统。 */

/**
 * Frontmatter parser for markdown memory files.
 *
 * Extracts YAML-like frontmatter between `---` delimiters.
 * Uses a minimal inline YAML parser to avoid external dependencies.
 */

import type { FrontmatterData, ParsedMarkdown } from './types.js'

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * 最小化 YAML 解析器，处理记忆 frontmatter 中使用的子集：
 * - 每行一个键值对
 * - 支持引号字符串和不带引号的字符串
 * - 跳过空行和注释行
 *
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
 * 解析 Markdown 内容，提取 frontmatter 和正文。
 *
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
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse frontmatter: ${error.message}`)
    }
    throw new Error('Failed to parse frontmatter: unknown error')
  }

  return { frontmatter, content }
}

/**
 * 根据 frontmatter 字段和正文构建记忆文件内容。
 *
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

// 按需为 YAML 值添加引号，防止特殊字符破坏格式
function escapeYamlValue(value: string): string {
  const needsQuotes = /[":#{}[\]|>&@`]/.test(value) || value.startsWith(' ') || value.endsWith(' ')
  if (needsQuotes) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

/** 中文说明：Skills 解析与提示模块。 */

import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import type { SkillDoc } from './types.js'

type Frontmatter = Record<string, string>

// 解析 Markdown 文件的 YAML frontmatter 头部，返回 frontmatter 键值对和正文
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---\n')) {
    return { frontmatter: {}, body: raw }
  }

  const end = trimmed.indexOf('\n---\n', 4)
  if (end < 0) {
    return { frontmatter: {}, body: raw }
  }

  const header = trimmed.slice(4, end)
  const body = trimmed.slice(end + 5)
  const frontmatter: Frontmatter = {}

  for (const line of header.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    frontmatter[key] = value
  }

  return { frontmatter, body }
}

// 规范化技能 ID：转为小写并将非法字符替换为短横线
function normalizeId(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9_\-:.]/g, '-')
}

// 从 frontmatter 中解析允许使用的工具列表（支持多种键名和 JSON 数组格式）
function parseAllowedTools(frontmatter: Frontmatter): string[] {
  const raw =
    frontmatter['allowed-tools'] ??
    frontmatter['allowed_tools'] ??
    frontmatter['tools'] ??
    ''

  if (!raw) return []

  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map(x => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }

  return raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
}

// 异步检查文件是否存在
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// 从 SKILL.md 文件中加载单个技能定义
async function loadSkillFromFile(path: string): Promise<SkillDoc> {
  const raw = await readFile(path, 'utf-8')
  const { frontmatter, body } = parseFrontmatter(raw)

  const folderName = basename(resolve(path, '..'))
  const name = frontmatter.name?.trim() || folderName
  const id = normalizeId(frontmatter.id?.trim() || name)
  const description = frontmatter.description?.trim() || undefined

  return {
    id,
    name,
    description,
    sourcePath: path,
    body: body.trim(),
    allowedTools: parseAllowedTools(frontmatter),
  }
}

/**
 * 从根目录中发现技能定义。
 * 支持以下两种目录结构：
 *   - <root>/SKILL.md
 *   - <root>/<skill-name>/SKILL.md
 *
 * Discover skills from root directories.
 * Supports either:
 *   - <root>/SKILL.md
 *   - <root>/<skill-name>/SKILL.md
 */
export async function loadSkills(skillRoots: string[]): Promise<SkillDoc[]> {
  const out: SkillDoc[] = []

  for (const rawRoot of skillRoots) {
    const root = resolve(rawRoot)

    const rootSkill = join(root, 'SKILL.md')
    if (await fileExists(rootSkill)) {
      out.push(await loadSkillFromFile(rootSkill))
    }

    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      continue
    }

    for (const entry of entries) {
      const skillFile = join(root, entry, 'SKILL.md')
      if (await fileExists(skillFile)) {
        out.push(await loadSkillFromFile(skillFile))
      }
    }
  }

  // keep first seen per id for deterministic resolution
  const seen = new Set<string>()
  const unique: SkillDoc[] = []
  for (const skill of out) {
    if (seen.has(skill.id)) continue
    seen.add(skill.id)
    unique.push(skill)
  }

  return unique
}

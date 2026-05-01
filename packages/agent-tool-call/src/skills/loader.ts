import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import type { SkillDoc } from './types.js'

type Frontmatter = Record<string, string>

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

function normalizeId(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9_\-:.]/g, '-')
}

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

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

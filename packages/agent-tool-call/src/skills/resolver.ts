import type { SkillDoc, SkillSelection } from './types.js'

function normalizeToken(v: string): string {
  return v.trim().toLowerCase()
}

export function extractSkillMentions(input: string): string[] {
  const out = new Set<string>()

  const dollarMatches = input.matchAll(/\$([a-zA-Z0-9_.:-]+)/g)
  for (const m of dollarMatches) {
    if (m[1]) out.add(normalizeToken(m[1]))
  }

  const skillMatches = input.matchAll(/\bskill:([a-zA-Z0-9_.:-]+)/gi)
  for (const m of skillMatches) {
    if (m[1]) out.add(normalizeToken(m[1]))
  }

  return [...out]
}

export function selectSkills(params: {
  available: SkillDoc[]
  requestedIds: string[]
  defaultIds?: string[]
}): SkillSelection {
  const requested = params.requestedIds.length > 0 ? params.requestedIds : (params.defaultIds ?? [])

  if (requested.length === 0) {
    return { active: [], unknownRequested: [] }
  }

  const byId = new Map<string, SkillDoc>()
  const byName = new Map<string, SkillDoc>()
  for (const s of params.available) {
    byId.set(normalizeToken(s.id), s)
    byName.set(normalizeToken(s.name), s)
  }

  const active: SkillDoc[] = []
  const unknownRequested: string[] = []
  const seen = new Set<string>()

  for (const req of requested.map(normalizeToken)) {
    const found = byId.get(req) ?? byName.get(req)
    if (!found) {
      unknownRequested.push(req)
      continue
    }
    if (seen.has(found.id)) continue
    seen.add(found.id)
    active.push(found)
  }

  return { active, unknownRequested }
}

export function buildToolAllowlistFromSkills(activeSkills: SkillDoc[]): Set<string> {
  const out = new Set<string>()
  for (const skill of activeSkills) {
    for (const t of skill.allowedTools) {
      if (!t.trim()) continue
      out.add(t.trim())
    }
  }
  return out
}

import type { SkillDoc } from './types.js'

export function buildSkillsPromptSection(activeSkills: SkillDoc[]): string {
  if (activeSkills.length === 0) return ''

  const sections = activeSkills.map(skill => {
    const header = `### Skill: ${skill.name} (${skill.id})`
    const desc = skill.description ? `Description: ${skill.description}\n` : ''
    const allow =
      skill.allowedTools.length > 0
        ? `Allowed tools hint: ${skill.allowedTools.map(t => `\`${t}\``).join(', ')}\n`
        : ''

    return [header, desc, allow, skill.body || '(empty SKILL.md body)'].filter(Boolean).join('\n')
  })

  return [
    '## Active skills',
    '',
    'The following skill instructions are active for this turn. Follow them in addition to the base system prompt.',
    '',
    ...sections,
  ].join('\n')
}

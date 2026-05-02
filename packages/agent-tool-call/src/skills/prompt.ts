/** 中文说明：Skills 解析与提示模块。 */

import type { SkillDoc } from './types.js'

/** 根据激活的技能列表构建 System Prompt 中的技能提示段落 */
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

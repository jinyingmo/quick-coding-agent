import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { loadSkills } from '../src/skills/loader.js'
import {
  buildToolAllowlistFromSkills,
  extractSkillMentions,
  selectSkills,
} from '../src/skills/resolver.js'

describe('skills runtime', () => {
  it('loads skill docs from root/<skill>/SKILL.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-test-'))
    const skillDir = join(root, 'deploy-skill')
    await mkdir(skillDir, { recursive: true })

    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: Deploy Flow',
        'id: deploy-flow',
        'description: Deployment guardrails',
        'allowed-tools: [bash, read_file]',
        '---',
        '',
        'Always run tests before deploy.',
      ].join('\n'),
      'utf-8',
    )

    const loaded = await loadSkills([root])
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('deploy-flow')
    expect(loaded[0]?.allowedTools).toEqual(['bash', 'read_file'])
    expect(loaded[0]?.body).toContain('Always run tests before deploy.')
  })

  it('extracts mentions and resolves skills by id or name', () => {
    const mentions = extractSkillMentions('Please use $deploy-flow and skill:qa-check now')
    expect(mentions).toEqual(['deploy-flow', 'qa-check'])

    const selection = selectSkills({
      available: [
        {
          id: 'deploy-flow',
          name: 'Deploy Flow',
          sourcePath: '/x/deploy/SKILL.md',
          body: 'deploy',
          allowedTools: ['bash'],
        },
      ],
      requestedIds: ['deploy-flow', 'missing-skill'],
    })

    expect(selection.active).toHaveLength(1)
    expect(selection.active[0]?.id).toBe('deploy-flow')
    expect(selection.unknownRequested).toEqual(['missing-skill'])
  })

  it('builds tool allowlist from selected skills', () => {
    const allow = buildToolAllowlistFromSkills([
      {
        id: 's1',
        name: 'Skill One',
        sourcePath: '/x/s1/SKILL.md',
        body: 'x',
        allowedTools: ['bash', 'read_file'],
      },
      {
        id: 's2',
        name: 'Skill Two',
        sourcePath: '/x/s2/SKILL.md',
        body: 'x',
        allowedTools: ['write_file'],
      },
    ])

    expect([...allow].sort()).toEqual(['bash', 'read_file', 'write_file'])
  })
})

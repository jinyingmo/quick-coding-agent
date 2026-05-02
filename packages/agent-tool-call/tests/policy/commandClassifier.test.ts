import { describe, expect, it } from 'vitest'
import { classifyCommand } from '../../src/policy/commandClassifier.js'

describe('classifyCommand', () => {
  const config = {
    allowCommands: ['pnpm test', 'git status'],
    confirmCommands: ['npm install'],
    denyPatterns: ['rm -rf'],
  }

  it('allows known safe commands', () => {
    expect(classifyCommand('pnpm test', config).disposition).toBe('allow')
  })

  it('requires confirmation for unknown commands', () => {
    expect(classifyCommand('node script.js', config).disposition).toBe('confirm')
  })

  it('denies explicitly dangerous commands', () => {
    expect(classifyCommand('rm -rf node_modules', config).disposition).toBe('deny')
  })
})

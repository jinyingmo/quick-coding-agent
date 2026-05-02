/** 中文说明：P0 权限策略模块。 */

export type CommandDisposition = 'allow' | 'confirm' | 'deny'

export type CommandClassification = {
  disposition: CommandDisposition
  summary: string
  reason: string
}

// 检查命令是否以给定前缀之一开头
function startsWithOneOf(input: string, patterns: string[]): string | undefined {
  return patterns.find(pattern => input === pattern || input.startsWith(pattern + ' '))
}

/** 对 shell 命令进行分类：根据配置的 allow/confirm/deny 规则返回处置建议 */
export function classifyCommand(
  rawCommand: string,
  config: {
    allowCommands: string[]
    confirmCommands: string[]
    denyPatterns: string[]
  },
): CommandClassification {
  const command = rawCommand.trim()
  if (command.length === 0) {
    return {
      disposition: 'deny',
      summary: 'Empty command',
      reason: 'Refusing to run an empty shell command.',
    }
  }

  const lower = command.toLowerCase()
  const deny = config.denyPatterns.find(pattern => lower.includes(pattern.toLowerCase()))
  if (deny) {
    return {
      disposition: 'deny',
      summary: 'Denied dangerous shell command',
      reason: `Command matched deny pattern: ${deny}`,
    }
  }

  if (/[|;&]/.test(command) || command.includes('&&') || command.includes('||') || command.includes('$(')) {
    return {
      disposition: 'confirm',
      summary: 'Complex shell command',
      reason: 'Complex shell commands require human approval in P0 mode.',
    }
  }

  const allowed = startsWithOneOf(command, config.allowCommands)
  if (allowed) {
    return {
      disposition: 'allow',
      summary: 'Approved low-risk shell command',
      reason: `Command matches allowed prefix: ${allowed}`,
    }
  }

  const confirm = startsWithOneOf(command, config.confirmCommands)
  if (confirm) {
    return {
      disposition: 'confirm',
      summary: 'Human approval required for shell command',
      reason: `Command matches confirm prefix: ${confirm}`,
    }
  }

  return {
    disposition: 'confirm',
    summary: 'Unclassified shell command',
    reason: 'Shell commands outside the allowlist require human approval in P0 mode.',
  }
}

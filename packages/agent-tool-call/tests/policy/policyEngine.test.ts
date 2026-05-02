import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDefaultMainPolicyConfig } from '../../src/policy/defaults.js'
import { createMainPolicyEngine, createPolicyCanUseTool } from '../../src/policy/engine.js'
import { createApprovalRegistry } from '../../src/runtime/approvalRegistry.js'
import type { Tool, ToolUseContext } from '../../src/types.js'

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({
      ...(name === 'bash'
        ? { command: z.string() }
        : { file_path: z.string(), content: z.string().optional(), old_string: z.string().optional(), new_string: z.string().optional() }),
    }).passthrough(),
    isReadOnly: () => false,
    call: async () => ({ data: {}, display: 'ok' }),
  }
}

const ctx: ToolUseContext = {
  cwd: '/repo',
  memoryDir: '/repo/memory',
  sessionId: 's1',
  userId: 'u1',
  workspaceId: 'w1',
  signal: new AbortController().signal,
  log: () => undefined,
}

describe('P0 policy engine', () => {
  it('requires confirmation for dependency installs', async () => {
    const approvals = createApprovalRegistry()
    const engine = createMainPolicyEngine({
      config: createDefaultMainPolicyConfig({ cwd: '/repo', memoryDir: '/repo/memory' }),
      identity: { sessionId: 's1', userId: 'u1', workspaceId: 'w1' },
      approvalRegistry: approvals,
    })
    const canUseTool = createPolicyCanUseTool({
      engine,
      identity: { sessionId: 's1', userId: 'u1', workspaceId: 'w1' },
      approvalRegistry: approvals,
    })

    const result = await canUseTool(makeTool('bash'), { command: 'npm install' }, ctx)
    expect(result.behavior).toBe('confirm')
  })

  it('denies writes outside allowed roots', async () => {
    const approvals = createApprovalRegistry()
    const engine = createMainPolicyEngine({
      config: createDefaultMainPolicyConfig({ cwd: '/repo', memoryDir: '/repo/memory' }),
      identity: { sessionId: 's1', userId: 'u1', workspaceId: 'w1' },
      approvalRegistry: approvals,
    })
    const canUseTool = createPolicyCanUseTool({
      engine,
      identity: { sessionId: 's1', userId: 'u1', workspaceId: 'w1' },
      approvalRegistry: approvals,
    })

    const result = await canUseTool(makeTool('write_file'), { file_path: '/etc/passwd', content: 'x' }, ctx)
    expect(result.behavior).toBe('deny')
  })
})

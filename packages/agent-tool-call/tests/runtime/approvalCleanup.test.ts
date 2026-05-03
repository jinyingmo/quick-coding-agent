import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApprovalRegistry } from '../../src/runtime/approvalRegistry.js'
import { createAgentRuntime } from '../../src/runtime/agentRuntime.js'
import { createSessionRegistry } from '../../src/runtime/sessionRegistry.js'
import { startRuntimeSweeper } from '../../src/runtime/sweeper.js'

describe('approval cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('prunes stale approval ids when reading session metadata', () => {
    const sessionRegistry = createSessionRegistry({
      ttlMs: 60_000,
      maxSessions: 10,
      maxMessagesPerSession: 20,
      maxTotalCharsPerSession: 10_000,
    })
    const approvalRegistry = createApprovalRegistry()
    const runtime = createAgentRuntime({ sessionRegistry, approvalRegistry })

    const { sessionId } = runtime.createSession({
      userId: 'demo-user',
      workspaceId: 'demo-workspace',
      cwd: '/repo',
      memoryDir: '/repo/memory',
    })

    const approval = approvalRegistry.create({
      sessionId,
      userId: 'demo-user',
      workspaceId: 'demo-workspace',
      actionType: 'bash',
      toolName: 'bash',
      riskLevel: 'high',
      summary: 'Run shell command',
      reason: 'Needs approval',
      input: { command: 'npm install' },
      ttlMs: 1,
    })
    sessionRegistry.addApproval(sessionId, approval.id)
    approvalRegistry.expireStale(approval.createdAt + 10)

    expect(runtime.getSession(sessionId).activeApprovalIds).toEqual([])
  })

  it('removes expired approval references during sweeps', async () => {
    vi.useFakeTimers()

    const sessionRegistry = createSessionRegistry({
      ttlMs: 60_000,
      maxSessions: 10,
      maxMessagesPerSession: 20,
      maxTotalCharsPerSession: 10_000,
    })
    const approvalRegistry = createApprovalRegistry()
    const session = sessionRegistry.create({
      userId: 'demo-user',
      workspaceId: 'demo-workspace',
      cwd: '/repo',
      memoryDir: '/repo/memory',
    })

    const approval = approvalRegistry.create({
      sessionId: session.sessionId,
      userId: 'demo-user',
      workspaceId: 'demo-workspace',
      actionType: 'bash',
      toolName: 'bash',
      riskLevel: 'high',
      summary: 'Run shell command',
      reason: 'Needs approval',
      input: { command: 'npm install' },
      ttlMs: 1,
    })
    sessionRegistry.addApproval(session.sessionId, approval.id)

    const stop = startRuntimeSweeper({
      sessionRegistry,
      approvalRegistry,
      intervalMs: 10,
    })

    await vi.advanceTimersByTimeAsync(20)
    stop()

    expect(sessionRegistry.require(session.sessionId).activeApprovalIds).toEqual([])
  })
})

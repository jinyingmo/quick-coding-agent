import { describe, expect, it } from 'vitest'
import { createApprovalRegistry } from '../../src/runtime/approvalRegistry.js'

describe('approvalRegistry', () => {
  it('creates and approves a pending approval', () => {
    const registry = createApprovalRegistry()
    const approval = registry.create({
      sessionId: 's1',
      userId: 'u1',
      workspaceId: 'w1',
      actionType: 'bash',
      toolName: 'bash',
      riskLevel: 'high',
      summary: 'Run install',
      reason: 'Needs approval',
      input: { command: 'npm install' },
      ttlMs: 1_000,
    })

    const result = registry.approve(approval.id, 'reviewer-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.approval.status).toBe('approved')
      expect(result.approval.reviewedBy).toBe('reviewer-1')
    }
  })

  it('expires stale approvals', () => {
    const registry = createApprovalRegistry()
    const approval = registry.create({
      sessionId: 's1',
      userId: 'u1',
      workspaceId: 'w1',
      actionType: 'bash',
      toolName: 'bash',
      riskLevel: 'high',
      summary: 'Run install',
      reason: 'Needs approval',
      input: { command: 'npm install' },
      ttlMs: 10,
    })

    const count = registry.expireStale(approval.createdAt + 20)
    expect(count).toBe(1)
    expect(registry.get(approval.id)?.status).toBe('expired')
  })
})

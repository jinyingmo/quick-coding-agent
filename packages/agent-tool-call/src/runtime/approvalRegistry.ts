/** 中文说明：P0 运行时状态模块。 */

import { randomUUID } from 'crypto'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type ApprovalActionType = 'bash' | 'write_file' | 'edit_file' | 'mcp'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export type ApprovalRequest = {
  id: string
  sessionId: string
  userId: string
  workspaceId: string
  actionType: ApprovalActionType
  toolName: string
  riskLevel: RiskLevel
  summary: string
  reason: string
  input: Record<string, unknown>
  createdAt: number
  expiresAt: number
}

export type PendingApproval = ApprovalRequest & {
  status: ApprovalStatus
  reviewedAt?: number
  reviewedBy?: string
}

export type ApprovalDecisionResult =
  | { ok: true; approval: PendingApproval }
  | { ok: false; code: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_RESOLVED' }

export type CreateApprovalInput = {
  sessionId: string
  userId: string
  workspaceId: string
  actionType: ApprovalActionType
  toolName: string
  riskLevel: RiskLevel
  summary: string
  reason: string
  input: Record<string, unknown>
  ttlMs: number
}

export type ApprovalRegistry = {
  create(input: CreateApprovalInput): PendingApproval
  get(id: string): PendingApproval | undefined
  approve(id: string, reviewerId: string): ApprovalDecisionResult
  reject(id: string, reviewerId: string): ApprovalDecisionResult
  expireStale(now?: number): { count: number; approvalIds: string[] }
  listBySession(sessionId: string): PendingApproval[]
  delete(id: string): void
}

/** 创建审批注册表，管理审批请求的创建、批准、拒绝和过期 */
export function createApprovalRegistry(): ApprovalRegistry {
  const approvals = new Map<string, PendingApproval>()

  // 获取当前时间戳（毫秒）
  function nowTs(): number {
    return Date.now()
  }

  // 检查审批是否已过期并自动标记为 expired
  function markExpiredIfNeeded(
    approval: PendingApproval | undefined,
    now = nowTs(),
  ): PendingApproval | undefined {
    if (!approval) return undefined
    if (approval.status !== 'pending') return approval
    if (approval.expiresAt > now) return approval
    approval.status = 'expired'
    return approval
  }

  return {
    // 创建待审批请求并写入存储
    create(input: CreateApprovalInput): PendingApproval {
      const createdAt = nowTs()
      const approval: PendingApproval = {
        id: randomUUID(),
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        actionType: input.actionType,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        summary: input.summary,
        reason: input.reason,
        input: input.input,
        createdAt,
        expiresAt: createdAt + input.ttlMs,
        status: 'pending',
      }
      approvals.set(approval.id, approval)
      return approval
    },

    // 按 ID 获取审批，自动标记过期
    get(id: string): PendingApproval | undefined {
      const approval = approvals.get(id)
      return markExpiredIfNeeded(approval)
    },

    // 批准指定审批，返回成功或对应错误码
    approve(id: string, reviewerId: string): ApprovalDecisionResult {
      const approval = approvals.get(id)
      if (!approval) return { ok: false, code: 'NOT_FOUND' }
      markExpiredIfNeeded(approval)
      if (approval.status === 'expired') return { ok: false, code: 'EXPIRED' }
      if (approval.status !== 'pending') {
        return { ok: false, code: 'ALREADY_RESOLVED' }
      }
      approval.status = 'approved'
      approval.reviewedBy = reviewerId
      approval.reviewedAt = nowTs()
      return { ok: true, approval }
    },

    // 拒绝指定审批，返回成功或对应错误码
    reject(id: string, reviewerId: string): ApprovalDecisionResult {
      const approval = approvals.get(id)
      if (!approval) return { ok: false, code: 'NOT_FOUND' }
      markExpiredIfNeeded(approval)
      if (approval.status === 'expired') return { ok: false, code: 'EXPIRED' }
      if (approval.status !== 'pending') {
        return { ok: false, code: 'ALREADY_RESOLVED' }
      }
      approval.status = 'rejected'
      approval.reviewedBy = reviewerId
      approval.reviewedAt = nowTs()
      return { ok: true, approval }
    },

    // 批量标记所有过期的待审批请求，返回过期数量
    expireStale(now = nowTs()): { count: number; approvalIds: string[] } {
      let expiredCount = 0
      const approvalIds: string[] = []
      for (const approval of approvals.values()) {
        if (approval.status === 'pending' && approval.expiresAt <= now) {
          approval.status = 'expired'
          expiredCount++
          approvalIds.push(approval.id)
        }
      }
      return { count: expiredCount, approvalIds }
    },

    // 列出指定会话的所有审批，按创建时间降序
    listBySession(sessionId: string): PendingApproval[] {
      const now = nowTs()
      const out: PendingApproval[] = []
      for (const approval of approvals.values()) {
        if (approval.sessionId !== sessionId) continue
        const normalized = markExpiredIfNeeded(approval, now)
        if (normalized) out.push(normalized)
      }
      return out.sort((a, b) => b.createdAt - a.createdAt)
    },

    // 删除指定审批
    delete(id: string): void {
      approvals.delete(id)
    },
  }
}

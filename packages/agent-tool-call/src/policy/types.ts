/** 中文说明：P0 权限策略模块。 */

import type { CanUseToolFn, ToolApprovalRequest, ToolUseContext } from '../types.js'
import type { MainPolicyConfig } from './defaults.js'

export type PolicyEngineInput = {
  toolName: string
  input: Record<string, unknown>
  context: ToolUseContext
}

export type PolicyEngineDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; reason?: string }
  | { behavior: 'deny'; code: string; reason: string }
  | { behavior: 'confirm'; code: string; reason: string; approvalRequest: ToolApprovalRequest }

export type PolicyEngine = {
  readonly config: MainPolicyConfig
  evaluate(input: PolicyEngineInput): Promise<PolicyEngineDecision>
}

export type SessionIdentity = {
  sessionId: string
  userId: string
  workspaceId: string
}

export type PolicyCanUseToolFactory = (identity: SessionIdentity) => CanUseToolFn

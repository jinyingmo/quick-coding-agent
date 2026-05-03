/** 中文说明：P0 运行时状态模块。 */

import { Agent, type AgentOptions } from '../agent.js'
import type { MCPSettings } from '../mcp/config.js'
import type { ApprovalRegistry } from './approvalRegistry.js'
import type { SessionRegistry } from './sessionRegistry.js'
import type { PendingApproval } from './approvalRegistry.js'
import type { Message } from '../types.js'
import { createSessionPolicyCanUseTool } from '../policy/engine.js'

export type StreamChunk = {
  type: string
  payload: Record<string, unknown>
}

export type AgentRuntime = {
  createSession(input: {
    userId: string
    workspaceId: string
    cwd: string
    memoryDir: string
  }): { sessionId: string }
  getSession(sessionId: string): {
    sessionId: string
    userId: string
    workspaceId: string
    cwd: string
    memoryDir: string
    messageCount: number
    activeApprovalIds: string[]
  }
  deleteSession(sessionId: string): Promise<boolean>
  getMessages(sessionId: string): Message[]
  sendMessage(input: {
    sessionId: string
    text: string
  }): Promise<
    | { status: 'completed'; reply: string }
    | { status: 'confirm_required'; approvalId: string; reason: string }
  >
  /** 流式发送消息，返回 AsyncGenerator 逐步推送内容 */
  sendMessageStream(input: {
    sessionId: string
    text: string
  }): AsyncGenerator<StreamChunk, void>
  extractMemories(sessionId: string): Promise<{ status: 'completed'; savedCount: number }>
  getApproval(approvalId: string): PendingApproval | undefined
  approve(input: { approvalId: string; reviewerId: string }): { status: 'approved' | 'not_found' | 'expired' | 'already_resolved' }
  reject(input: { approvalId: string; reviewerId: string }): { status: 'rejected' | 'not_found' | 'expired' | 'already_resolved' }
  dispose(): Promise<void>
}

/** 创建 Agent 运行时，包装会话管理和 Agent 调度的外观层 */
export function createAgentRuntime(params: {
  sessionRegistry: SessionRegistry
  approvalRegistry: ApprovalRegistry
  agentOptions?: Partial<Omit<AgentOptions, 'cwd' | 'memoryDir' | 'log'>>
  mcpSettings?: MCPSettings
  allowedMcpTools?: string[]
  log?: (msg: string, level?: 'debug' | 'info' | 'warn' | 'error') => void
}): AgentRuntime {
  const agents = new Map<string, Agent>()
  const log = params.log ?? (() => undefined)

  // 按 sessionId 获取 Agent 实例，不存在时抛出错误
  function getAgent(sessionId: string): Agent {
    const agent = agents.get(sessionId)
    if (!agent) {
      throw new Error(`Agent not found for session ${sessionId}`)
    }
    return agent
  }

  function syncActiveApprovalIds(sessionId: string): string[] {
    const session = params.sessionRegistry.require(sessionId)
    const staleIds = session.activeApprovalIds.filter(id => {
      const approval = params.approvalRegistry.get(id)
      return !approval || approval.status !== 'pending'
    })

    for (const approvalId of staleIds) {
      params.sessionRegistry.removeApproval(sessionId, approvalId)
    }

    return params.sessionRegistry.require(sessionId).activeApprovalIds
  }

  return {
    // 创建新会话并初始化 Agent 实例
    createSession(input) {
      const session = params.sessionRegistry.create(input)
      const canUseTool = createSessionPolicyCanUseTool({
        identity: {
          sessionId: session.sessionId,
          userId: session.userId,
          workspaceId: session.workspaceId,
        },
        approvalRegistry: params.approvalRegistry,
        cwd: session.cwd,
        memoryDir: session.memoryDir,
        allowedMcpTools: params.allowedMcpTools,
      })
      const agent = new Agent({
        cwd: session.cwd,
        memoryDir: session.memoryDir,
        log,
        maxTurns: params.agentOptions?.maxTurns,
        onMemoriesSaved: params.agentOptions?.onMemoriesSaved,
        capabilityProviders: params.agentOptions?.capabilityProviders,
        mcpSettings: params.mcpSettings,
        skills: params.agentOptions?.skills,
        turnsPerExtraction: params.agentOptions?.turnsPerExtraction,
        autoExtractMemories: false,
        canUseTool,
      })
      agents.set(session.sessionId, agent)
      return { sessionId: session.sessionId }
    },

    // 获取会话摘要信息
    getSession(sessionId) {
      const session = params.sessionRegistry.require(sessionId)
      return {
        sessionId: session.sessionId,
        userId: session.userId,
        workspaceId: session.workspaceId,
        cwd: session.cwd,
        memoryDir: session.memoryDir,
        messageCount: session.messages.length,
        activeApprovalIds: [...syncActiveApprovalIds(sessionId)],
      }
    },

    // 删除会话并释放关联的 Agent 资源
    async deleteSession(sessionId) {
      const agent = agents.get(sessionId)
      if (agent) {
        await agent.drain(1_000)
        agents.delete(sessionId)
      }
      return params.sessionRegistry.delete(sessionId)
    },

    // 获取会话的完整消息列表（返回副本）
    getMessages(sessionId) {
      const session = params.sessionRegistry.require(sessionId)
      return [...session.messages]
    },

    // 向 Agent 发送消息，处理回复和审批请求
    async sendMessage(input) {
      const session = params.sessionRegistry.require(input.sessionId)
      const agent = getAgent(input.sessionId)
      const result = await agent.executeTurn(input.text)
      params.sessionRegistry.replaceMessages(input.sessionId, agent.historySnapshot())

      if (result.status === 'confirm_required' && result.approvalRequest) {
        params.sessionRegistry.addApproval(input.sessionId, result.approvalRequest.id)
        return {
          status: 'confirm_required',
          approvalId: result.approvalRequest.id,
          reason: result.reason ?? 'Human approval required.',
        }
      }

      if (result.status === 'completed' && result.finalMessage) {
        return {
          status: 'completed',
          reply: result.finalMessage.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n'),
        }
      }

      return {
        status: 'completed',
        reply: result.finalMessage?.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n') ?? 'Request ended without a final text response.',
      }
    },

    // 流式发送消息：逐步 yield LLM 增量块
    async *sendMessageStream(input) {
      const agent = getAgent(input.sessionId)

      try {
        const gen = agent.streamChat(input.text)
        let result
        while (true) {
          const { value, done } = await gen.next()
          if (done) {
            result = value
            break
          }
          if (value.type === 'confirm_required') {
            params.sessionRegistry.addApproval(input.sessionId, value.approvalId)
          }
          const chunk = value
          yield { type: chunk.type, payload: chunk as unknown as Record<string, unknown> }
        }

        if (result?.status === 'confirm_required' && result.approvalRequest) {
          params.sessionRegistry.addApproval(input.sessionId, result.approvalRequest.id)
        }
      } finally {
        params.sessionRegistry.replaceMessages(input.sessionId, agent.historySnapshot())
      }
    },

    // 从当前会话提取记忆并同步消息历史
    async extractMemories(sessionId) {
      const agent = getAgent(sessionId)
      const saved = await agent.extractMemoriesNow()
      params.sessionRegistry.replaceMessages(sessionId, agent.historySnapshot())
      return { status: 'completed', savedCount: saved.length }
    },

    // 按 ID 获取审批请求
    getApproval(approvalId) {
      return params.approvalRegistry.get(approvalId)
    },

    // 批准指定审批请求并清理会话关联
    approve(input) {
      const result = params.approvalRegistry.approve(input.approvalId, input.reviewerId)
      if (!result.ok) {
        return {
          status:
            result.code === 'NOT_FOUND'
              ? 'not_found'
              : result.code === 'EXPIRED'
                ? 'expired'
                : 'already_resolved',
        }
      }
      params.sessionRegistry.removeApproval(result.approval.sessionId, result.approval.id)
      return { status: 'approved' }
    },

    // 拒绝指定审批请求并清理会话关联
    reject(input) {
      const result = params.approvalRegistry.reject(input.approvalId, input.reviewerId)
      if (!result.ok) {
        return {
          status:
            result.code === 'NOT_FOUND'
              ? 'not_found'
              : result.code === 'EXPIRED'
                ? 'expired'
                : 'already_resolved',
        }
      }
      params.sessionRegistry.removeApproval(result.approval.sessionId, result.approval.id)
      return { status: 'rejected' }
    },

    // 释放所有 Agent 实例并清空注册表
    async dispose() {
      for (const agent of agents.values()) {
        await agent.drain(1_000)
      }
      agents.clear()
    },
  }
}

/** 中文说明：P0 权限策略模块。 */

import { resolve } from 'path'
import type { CanUseToolFn, Tool, ToolApprovalRequest, ToolUseContext } from '../types.js'
import type { ApprovalRegistry } from '../runtime/approvalRegistry.js'
import { classifyCommand } from './commandClassifier.js'
import { createDefaultMainPolicyConfig, type MainPolicyConfig } from './defaults.js'
import type { PolicyCanUseToolFactory, PolicyEngine, SessionIdentity } from './types.js'

// 检查文件路径是否在允许的根目录范围内
function isWithinRoots(filePath: string, roots: string[]): boolean {
  const abs = resolve(filePath)
  return roots.some(root => {
    const normalized = resolve(root)
    return abs === normalized || abs.startsWith(normalized + '/')
  })
}

// 检查文件路径是否包含受保护的片段
function isProtectedPath(filePath: string, protectedFragments: string[]): boolean {
  const abs = resolve(filePath)
  return protectedFragments.some(fragment => abs.includes(fragment))
}

// 创建人工审批请求
function createApprovalRequest(params: {
  registry: ApprovalRegistry
  identity: SessionIdentity
  toolName: string
  actionType: ToolApprovalRequest['actionType']
  riskLevel: ToolApprovalRequest['riskLevel']
  summary: string
  reason: string
  input: Record<string, unknown>
  ttlMs: number
}): ToolApprovalRequest {
  return params.registry.create({
    sessionId: params.identity.sessionId,
    userId: params.identity.userId,
    workspaceId: params.identity.workspaceId,
    actionType: params.actionType,
    toolName: params.toolName,
    riskLevel: params.riskLevel,
    summary: params.summary,
    reason: params.reason,
    input: params.input,
    ttlMs: params.ttlMs,
  })
}

// 构建拒绝决策结果
function deny(code: string, reason: string) {
  return { behavior: 'deny' as const, code, reason }
}

// 构建允许决策结果
function allow(updatedInput: Record<string, unknown>, reason?: string) {
  return { behavior: 'allow' as const, updatedInput, reason }
}

// 构建需人工确认的决策结果
function confirm(params: {
  code: string
  reason: string
  approvalRequest: ToolApprovalRequest
}) {
  return {
    behavior: 'confirm' as const,
    code: params.code,
    reason: params.reason,
    approvalRequest: params.approvalRequest,
  }
}

/** 创建主策略引擎：根据工具类型（读/写/bash/mcp）评估是否允许调用 */
export function createMainPolicyEngine(params: {
  config: MainPolicyConfig
  identity: SessionIdentity
  approvalRegistry: ApprovalRegistry
}): PolicyEngine {
  const { config, identity, approvalRegistry } = params

  return {
    config,
    // 评估工具调用请求，根据规则返回 allow / deny / confirm 决策
    async evaluate({ toolName, input, context }) {
      if (['read_file', 'list_dir', 'glob', 'grep', 'search_memory'].includes(toolName)) {
        return allow(input, 'Read-only tool allowed by default.')
      }

      if (toolName === 'edit_file' || toolName === 'write_file') {
        const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
        if (!filePath) {
          return deny('MISSING_FILE_PATH', `${toolName} requires a string file_path.`)
        }
        if (!isWithinRoots(filePath, config.allowedWriteRoots)) {
          return deny(
            'WRITE_OUTSIDE_ALLOWED_ROOTS',
            `Refusing ${toolName}: ${resolve(filePath)} is outside the allowed write roots.`,
          )
        }
        if (isProtectedPath(filePath, config.protectedPathFragments)) {
          return confirm({
            code: 'WRITE_PROTECTED_PATH',
            reason: `Writing ${resolve(filePath)} requires human approval in P0 mode.`,
            approvalRequest: createApprovalRequest({
              registry: approvalRegistry,
              identity,
              toolName,
              actionType: toolName === 'edit_file' ? 'edit_file' : 'write_file',
              riskLevel: 'high',
              summary: `Modify protected path: ${resolve(filePath)}`,
              reason: `Protected path matched for ${resolve(filePath)}.`,
              input,
              ttlMs: config.approvalTtlMs,
            }),
          })
        }
        return allow(input, `${toolName} is inside the allowed write roots.`)
      }

      if (toolName === 'bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        const classified = classifyCommand(command, config.bash)
        if (classified.disposition === 'deny') {
          return deny('BASH_DENIED', classified.reason)
        }
        if (classified.disposition === 'confirm') {
          return confirm({
            code: 'BASH_CONFIRM_REQUIRED',
            reason: classified.reason,
            approvalRequest: createApprovalRequest({
              registry: approvalRegistry,
              identity,
              toolName,
              actionType: 'bash',
              riskLevel: 'high',
              summary: classified.summary,
              reason: classified.reason,
              input,
              ttlMs: config.approvalTtlMs,
            }),
          })
        }
        return allow(input, classified.reason)
      }

      if (toolName.startsWith('mcp__')) {
        if (!config.allowedMcpTools.includes(toolName)) {
          return deny('MCP_TOOL_NOT_ALLOWED', `${toolName} is not allowed by the MCP allowlist.`)
        }
        return confirm({
          code: 'MCP_CONFIRM_REQUIRED',
          reason: `${toolName} requires human approval in P0 mode.`,
          approvalRequest: createApprovalRequest({
            registry: approvalRegistry,
            identity,
            toolName,
            actionType: 'mcp',
            riskLevel: 'high',
            summary: `Invoke MCP tool ${toolName}`,
            reason: `${toolName} is allowlisted but still requires approval in P0 mode.`,
            input,
            ttlMs: config.approvalTtlMs,
          }),
        })
      }

      context.log(`[policy] no rule matched for ${toolName}`, 'warn')
      return deny('UNKNOWN_TOOL_POLICY', `No P0 policy rule matched for ${toolName}.`)
    },
  }
}

  /** 创建基于策略引擎的 canUseTool 实现 */
export function createPolicyCanUseTool(params: {
  engine: PolicyEngine
  identity: SessionIdentity
  approvalRegistry: ApprovalRegistry
}): CanUseToolFn {
  const { engine } = params
  // 校验输入并调用策略引擎评估工具调用权限
  return async function canUseTool(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ) {
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        behavior: 'deny',
        message: `Invalid input for ${tool.name}: ${parsed.error.message}`,
      }
    }

    const decision = await engine.evaluate({
      toolName: tool.name,
      input: parsed.data,
      context,
    })

    if (decision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: decision.updatedInput }
    }
    if (decision.behavior === 'confirm') {
      return {
        behavior: 'confirm',
        message: decision.reason,
        approvalRequest: decision.approvalRequest,
      }
    }
    return { behavior: 'deny', message: decision.reason }
  }
}

/** 创建会话级策略的工厂函数：为每个会话返回一个独立的 canUseTool 函数 */
export function createSessionPolicyCanUseToolFactory(params: {
  approvalRegistry: ApprovalRegistry
}): PolicyCanUseToolFactory {
  // 为每个会话身份创建独立的策略配置和引擎
  return function makePolicy(identity: SessionIdentity): CanUseToolFn {
    const config = createDefaultMainPolicyConfig({
      cwd: process.cwd(),
      memoryDir: process.cwd(),
    })
    const engine = createMainPolicyEngine({
      config,
      identity,
      approvalRegistry: params.approvalRegistry,
    })
    return createPolicyCanUseTool({
      engine,
      identity,
      approvalRegistry: params.approvalRegistry,
    })
  }
}

/** 直接创建会话级 canUseTool 函数（合并默认配置与自定义参数） */
export function createSessionPolicyCanUseTool(params: {
  identity: SessionIdentity
  approvalRegistry: ApprovalRegistry
  cwd: string
  memoryDir: string
  allowedMcpTools?: string[]
}): CanUseToolFn {
  const config = {
    ...createDefaultMainPolicyConfig({ cwd: params.cwd, memoryDir: params.memoryDir }),
    allowedMcpTools: params.allowedMcpTools ?? [],
  }
  const engine = createMainPolicyEngine({
    config,
    identity: params.identity,
    approvalRegistry: params.approvalRegistry,
  })
  return createPolicyCanUseTool({
    engine,
    identity: params.identity,
    approvalRegistry: params.approvalRegistry,
  })
}

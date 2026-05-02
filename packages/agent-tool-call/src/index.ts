/** 中文说明：核心 agent 模块。 */

export type {
  Message,
  Tool,
  ToolUseContext,
  CanUseToolFn,
  ToolResult,
  PermissionResult,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  UserMessage,
  AssistantMessage,
  ToolApprovalRequest,
  LogLevel,
} from './types.js'

export {
  createUserMessage,
  createAssistantMessage,
  getToolUses,
  getText,
} from './types.js'

export { Agent } from './agent.js'
export { runQueryLoop } from './query.js'
export { ALL_TOOLS, findToolByName } from './tools/index.js'
export { runForkedAgent, extractWrittenPaths, hasMemoryWritesSince } from './forkedAgent.js'
export { initExtractMemories } from './extractMemories.js'
export { buildSystemPrompt } from './systemPrompt.js'
export { allowAllPermission, restrictToMemoryDirPermission } from './permissions.js'
export { createLocalToolsProvider } from './capabilities/localProvider.js'
export { resolveToolsFromProviders } from './capabilities/resolveTools.js'
export type { CapabilityProvider, CapabilityProviderContext } from './capabilities/types.js'
export { createMCPProvider } from './mcp/provider.js'
export { loadMCPSettingsFromEnv } from './mcp/config.js'
export type { MCPSettings, MCPServerConfig } from './mcp/config.js'
export { loadSkills } from './skills/loader.js'
export { extractSkillMentions, selectSkills, buildToolAllowlistFromSkills } from './skills/resolver.js'
export { buildSkillsPromptSection } from './skills/prompt.js'
export type { SkillDoc, SkillSelection } from './skills/types.js'
export * from './memory/index.js'
export * from './runtime/sessionTypes.js'
export { createSessionRegistry } from './runtime/sessionRegistry.js'
export { createApprovalRegistry } from './runtime/approvalRegistry.js'
export { startRuntimeSweeper } from './runtime/sweeper.js'
export { createAgentRuntime } from './runtime/agentRuntime.js'
export { createStructuredLogger } from './observability/logger.js'
export { loadApiKeyIdentitiesFromEnv, findIdentityByBearerToken } from './auth/apiKey.js'
export { createMainPolicyEngine, createPolicyCanUseTool, createSessionPolicyCanUseTool } from './policy/engine.js'
export { createDefaultMainPolicyConfig } from './policy/defaults.js'
export { classifyCommand } from './policy/commandClassifier.js'
export type { MainPolicyConfig } from './policy/defaults.js'
export type { PolicyEngine, PolicyEngineDecision, SessionIdentity } from './policy/types.js'
export { createP0Server } from './server/app.js'

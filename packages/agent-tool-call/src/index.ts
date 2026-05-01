// Public API for @quick-coding-agent/agent-tool-call

// Types
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
} from './types.js'

export {
  createUserMessage,
  createAssistantMessage,
  getToolUses,
  getText,
} from './types.js'

// Agent
export { Agent } from './agent.js'

// Query loop
export { runQueryLoop } from './query.js'

// Tools
export { ALL_TOOLS, findToolByName } from './tools/index.js'

// Forked agent
export { runForkedAgent, extractWrittenPaths, hasMemoryWritesSince } from './forkedAgent.js'

// Memory extraction
export { initExtractMemories } from './extractMemories.js'

// System prompt
export { buildSystemPrompt } from './systemPrompt.js'

// Permissions
export { allowAllPermission, restrictToMemoryDirPermission } from './permissions.js'

// Capability providers
export { createLocalToolsProvider } from './capabilities/localProvider.js'
export { resolveToolsFromProviders } from './capabilities/resolveTools.js'
export type { CapabilityProvider, CapabilityProviderContext } from './capabilities/types.js'

// MCP
export { createMCPProvider } from './mcp/provider.js'
export { loadMCPSettingsFromEnv } from './mcp/config.js'
export type { MCPSettings, MCPServerConfig } from './mcp/config.js'

// Skills
export { loadSkills } from './skills/loader.js'
export { extractSkillMentions, selectSkills, buildToolAllowlistFromSkills } from './skills/resolver.js'
export { buildSkillsPromptSection } from './skills/prompt.js'
export type { SkillDoc, SkillSelection } from './skills/types.js'

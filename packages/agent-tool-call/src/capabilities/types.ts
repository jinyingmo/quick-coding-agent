import type { Tool, ToolUseContext } from '../types.js'

export type CapabilityProviderContext = {
  cwd: string
  memoryDir: string
  log: ToolUseContext['log']
  signal?: AbortSignal
}

export type CapabilityProvider = {
  /** Provider id for logging and diagnostics. */
  readonly id: string
  /** Source category for the provider. */
  readonly source: 'local' | 'mcp'
  /** Resolve tools currently exposed by this provider. */
  getTools(ctx: CapabilityProviderContext): Promise<Tool[]>
  /** Optional provider-level cleanup hook. */
  dispose?: () => Promise<void>
}

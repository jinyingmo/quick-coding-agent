/**
 * High-level Agent orchestrator.
 *
 * Wires together:
 *   - System prompt (memory section + tool catalog)
 *   - Capability providers (local tools + optional MCP tools)
 *   - Permission policy (allow-all for the main agent)
 *   - Stop hook → background memory extraction
 */

import { delimiter, resolve } from 'path'
import { allowAllPermission } from './permissions.js'
import { runQueryLoop, type StopHookFn } from './query.js'
import {
  initExtractMemories,
  type ExtractMemoriesController,
} from './extractMemories.js'
import { buildSystemPrompt } from './systemPrompt.js'
import type { Message, Tool, ToolUseContext } from './types.js'
import { createUserMessage, getText } from './types.js'
import { createLocalToolsProvider } from './capabilities/localProvider.js'
import {
  resolveToolsFromProviders,
  type CapabilityResolveResult,
} from './capabilities/resolveTools.js'
import type { CapabilityProvider } from './capabilities/types.js'
import { createMCPProvider } from './mcp/provider.js'
import { loadMCPSettingsFromEnv, type MCPSettings } from './mcp/config.js'
import { loadSkills } from './skills/loader.js'
import {
  buildToolAllowlistFromSkills,
  extractSkillMentions,
  selectSkills,
} from './skills/resolver.js'
import { buildSkillsPromptSection } from './skills/prompt.js'
import type { SkillDoc } from './skills/types.js'

export type SkillRuntimeOptions = {
  roots?: string[]
  defaultSkills?: string[]
  strictToolAllowlist?: boolean
}

export type AgentOptions = {
  cwd: string
  memoryDir: string
  agentName?: string
  /** Throttle for the background extractor. */
  turnsPerExtraction?: number
  maxTurns?: number
  log?: ToolUseContext['log']
  onMemoriesSaved?: (paths: string[]) => void
  /** Optional external capability providers. Local provider is always included. */
  capabilityProviders?: CapabilityProvider[]
  /** Optional MCP settings. If omitted, environment variables are used. */
  mcpSettings?: MCPSettings
  /** Optional skills runtime config. */
  skills?: SkillRuntimeOptions
}

type RuntimeState = {
  providers: CapabilityProvider[]
  availableSkills: SkillDoc[]
  activeSkills: SkillDoc[]
  strictSkillToolAllowlist: boolean
}

export class Agent {
  readonly opts: AgentOptions
  private tools: Tool[] = []
  private readonly extractor: ExtractMemoriesController
  private readonly history: Message[] = []
  private systemPrompt: string | undefined
  private readonly abortController = new AbortController()
  private readonly log: NonNullable<AgentOptions['log']>
  private readonly runtimeWarnings: string[] = []

  private runtimeState: RuntimeState | undefined
  private runtimeInitPromise: Promise<void> | undefined

  constructor(opts: AgentOptions) {
    this.opts = opts
    this.log =
      opts.log ??
      ((msg, level = 'info') => {
        if (level === 'debug' && !process.env.DEBUG) return
        const prefix = `[${level}]`.padEnd(7)
        console.error(`${prefix} ${msg}`)
      })
    this.extractor = initExtractMemories({
      memoryDir: opts.memoryDir,
      turnsPerExtraction: opts.turnsPerExtraction ?? 1,
      onSaved: paths => opts.onMemoriesSaved?.(paths),
    })
  }

  private async ensureRuntimeInitialized(): Promise<void> {
    if (this.runtimeState) return
    if (!this.runtimeInitPromise) {
      this.runtimeInitPromise = this.initRuntime()
    }
    await this.runtimeInitPromise
  }

  private async initRuntime(): Promise<void> {
    const providers: CapabilityProvider[] = [createLocalToolsProvider()]

    if (this.opts.capabilityProviders && this.opts.capabilityProviders.length > 0) {
      providers.push(...this.opts.capabilityProviders)
    }

    const mcpSettings = this.opts.mcpSettings ?? (await loadMCPSettingsFromEnv())
    if (mcpSettings.enabled && mcpSettings.servers.length > 0) {
      providers.push(createMCPProvider({ servers: mcpSettings.servers }))
      this.log(
        `[agent] mcp enabled: ${mcpSettings.servers.length} server(s) configured`,
        'info',
      )
    }

    const skillRoots = this.resolveSkillRoots(this.opts.skills?.roots)
    const availableSkills =
      skillRoots.length > 0 ? await loadSkills(skillRoots) : []

    const defaultSkills = this.resolveDefaultSkillIds(this.opts.skills?.defaultSkills)
    const defaultSelection = selectSkills({
      available: availableSkills,
      requestedIds: defaultSkills,
    })

    if (defaultSelection.unknownRequested.length > 0) {
      this.runtimeWarnings.push(
        `[skills] unknown default skills: ${defaultSelection.unknownRequested.join(', ')}`,
      )
    }

    const strictSkillToolAllowlist =
      this.opts.skills?.strictToolAllowlist ??
      parseBooleanEnv(process.env.SKILL_STRICT_ALLOWLIST, false)

    this.runtimeState = {
      providers,
      availableSkills,
      activeSkills: defaultSelection.active,
      strictSkillToolAllowlist,
    }

    this.log(
      `[agent] runtime initialized: providers=${providers.length}, skills=${availableSkills.length}, activeSkills=${defaultSelection.active.length}`,
      'info',
    )

    for (const warning of this.runtimeWarnings) {
      this.log(warning, 'warn')
    }
  }

  private resolveSkillRoots(explicit?: string[]): string[] {
    if (explicit && explicit.length > 0) return explicit.map(p => resolve(p))

    const raw = process.env.SKILL_ROOTS?.trim()
    if (!raw) return []

    return raw
      .split(delimiter)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => resolve(p))
  }

  private resolveDefaultSkillIds(explicit?: string[]): string[] {
    if (explicit && explicit.length > 0) return explicit

    const raw = process.env.SKILLS?.trim()
    if (!raw) return []

    return raw
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  }

  private async refreshCapabilities(): Promise<CapabilityResolveResult> {
    await this.ensureRuntimeInitialized()
    const state = this.runtimeState!

    const resolved = await resolveToolsFromProviders(state.providers, {
      cwd: this.opts.cwd,
      memoryDir: this.opts.memoryDir,
      log: this.log,
      signal: this.abortController.signal,
    })

    this.tools = this.applySkillToolPolicy(resolved.tools)
    this.log(
      `[agent] active tools: ${this.tools.length}/${resolved.tools.length} after skill policy`,
      'info',
    )

    return resolved
  }

  private applySkillToolPolicy(tools: Tool[]): Tool[] {
    const state = this.runtimeState
    if (!state) return tools

    const allowlist = buildToolAllowlistFromSkills(state.activeSkills)
    if (!state.strictSkillToolAllowlist || allowlist.size === 0) {
      return tools
    }

    return tools.filter(tool => {
      if (allowlist.has(tool.name)) return true
      const originalName = tool.metadata?.originalName
      if (originalName && allowlist.has(originalName)) return true
      const server = tool.metadata?.server
      if (server && originalName && allowlist.has(`mcp:${server}:${originalName}`)) return true
      return false
    })
  }

  private async applySkillMentions(userInput: string): Promise<boolean> {
    await this.ensureRuntimeInitialized()
    const state = this.runtimeState!

    const mentioned = extractSkillMentions(userInput)
    if (mentioned.length === 0) return false

    const selection = selectSkills({
      available: state.availableSkills,
      requestedIds: mentioned,
    })

    if (selection.unknownRequested.length > 0) {
      this.log(
        `[skills] unknown skill mentions: ${selection.unknownRequested.join(', ')}`,
        'warn',
      )
    }

    const previous = new Set(state.activeSkills.map(s => s.id))
    const next = new Set(selection.active.map(s => s.id))
    if (previous.size === next.size && [...previous].every(id => next.has(id))) {
      return false
    }

    state.activeSkills = selection.active
    this.log(
      `[skills] active skills updated: ${state.activeSkills.map(s => s.id).join(', ') || '(none)'}`,
      'info',
    )
    return true
  }

  /**
   * Rebuild the system prompt — call this when memory contents change
   * out-of-band so the next turn sees the fresh MEMORY.md.
   */
  async refreshSystemPrompt(): Promise<void> {
    await this.refreshCapabilities()
    await this.ensureRuntimeInitialized()

    const skillsSection = buildSkillsPromptSection(this.runtimeState!.activeSkills)

    this.systemPrompt = await buildSystemPrompt({
      memoryDir: this.opts.memoryDir,
      tools: this.tools,
      agentName: this.opts.agentName,
      cwd: this.opts.cwd,
      extraSections: skillsSection ? [skillsSection] : undefined,
    })
  }

  /** Run one full turn for the given user input. Returns the assistant reply text. */
  async chat(userInput: string): Promise<string> {
    const skillChanged = await this.applySkillMentions(userInput)
    if (!this.systemPrompt || skillChanged) {
      await this.refreshSystemPrompt()
    }

    this.history.push(createUserMessage(userInput))

    const ctx: ToolUseContext = {
      cwd: this.opts.cwd,
      memoryDir: this.opts.memoryDir,
      log: this.log,
      signal: this.abortController.signal,
    }

    const stopHook: StopHookFn = async ({ messages, context }) => {
      // Fire-and-forget: don't block returning the reply on extraction.
      void this.extractor.run(messages, context)
    }

    const result = await runQueryLoop({
      systemPrompt: this.systemPrompt!,
      messages: this.history,
      tools: this.tools,
      canUseTool: allowAllPermission,
      context: ctx,
      maxTurns: this.opts.maxTurns ?? 10,
      stopHooks: [stopHook],
    })

    // Persist newly added messages (the queryLoop returned a *copy* with the
    // assistant + any tool_result rounds appended).
    while (this.history.length < result.messages.length) {
      this.history.push(result.messages[this.history.length]!)
    }

    return getText(result.finalMessage)
  }

  /** Wait for any in-flight memory extraction to complete (called on shutdown). */
  async drain(timeoutMs?: number): Promise<void> {
    await this.extractor.drain(timeoutMs)
    await this.disposeProviders()
  }

  private async disposeProviders(): Promise<void> {
    if (!this.runtimeState) return
    for (const provider of this.runtimeState.providers) {
      if (!provider.dispose) continue
      try {
        await provider.dispose()
      } catch (err) {
        this.log(
          `[agent] provider dispose failed (${provider.id}): ${(err as Error).message}`,
          'warn',
        )
      }
    }
  }

  /** Number of messages in the conversation history (for display). */
  historyLength(): number {
    return this.history.length
  }

  toolNames(): string[] {
    return this.tools.map(t => t.name)
  }

  activeSkillIds(): string[] {
    if (!this.runtimeState) return []
    return this.runtimeState.activeSkills.map(s => s.id)
  }

  abort(): void {
    this.abortController.abort()
  }
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback
  const value = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false
  return fallback
}

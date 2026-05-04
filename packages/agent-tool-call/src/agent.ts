import { delimiter, resolve } from 'path'
import { allowAllPermission } from './permissions.js'
import {
  type QueryResult,
  type QueryStreamChunk,
} from './query.js'
import { type TokenUsage } from './llm.js'
import { buildSystemPrompt } from './systemPrompt.js'
import type { CanUseToolFn, Message, Tool, ToolUseContext } from './types.js'
import { createLocalToolsProvider } from './capabilities/localProvider.js'
import { resolveToolsFromProviders } from './capabilities/resolveTools.js'
import type { CapabilityProvider } from './capabilities/types.js'
import { createMCPProvider } from './mcp/provider.js'
import { loadMCPSettingsFromEnv, type MCPSettings } from './mcp/config.js'
import { loadSkills } from './skills/loader.js'
import { buildToolAllowlistFromSkills, selectSkills } from './skills/resolver.js'
import { buildSkillsPromptSection } from './skills/prompt.js'
import type { SkillDoc } from './skills/types.js'
import {
  ConversationSession,
  type SessionDeps,
  type SessionOptions,
} from './session.js'

export type { SessionOptions }

export type SkillRuntimeOptions = {
  roots?: string[]
  defaultSkills?: string[]
  strictToolAllowlist?: boolean
}

export type AgentOptions = {
  cwd: string
  memoryDir: string
  agentName?: string
  turnsPerExtraction?: number
  maxTurns?: number
  log?: ToolUseContext['log']
  onMemoriesSaved?: (paths: string[]) => void
  capabilityProviders?: CapabilityProvider[]
  mcpSettings?: MCPSettings
  skills?: SkillRuntimeOptions
  canUseTool?: CanUseToolFn
  autoExtractMemories?: boolean
}

type RuntimeState = {
  providers: CapabilityProvider[]
  availableSkills: SkillDoc[]
  activeSkills: SkillDoc[]
  strictSkillToolAllowlist: boolean
}

/**
 * Agent 类：持有共享只读基础设施，并作为 ConversationSession 的工厂。
 *
 * ## 并发模型
 *
 * Agent 内部所有可变状态均为"初始化一次、之后只读"：
 *   - runtimeState   — providers、availableSkills（initRuntime 后不再变更）
 *   - allToolsCache  — 工具列表，单次 Promise 懒加载后永久缓存
 *
 * getCapabilitiesForSkills() 是纯计算（基于上述缓存），可被任意数量的
 * ConversationSession 并发调用，无需任何锁。
 *
 * 每条独立对话请使用 agent.createSession() 创建 ConversationSession，
 * 会话状态（history、activeSkills、abortController、extractor）完全隔离。
 */
export class Agent {
  readonly opts: AgentOptions
  private readonly log: NonNullable<AgentOptions['log']>
  private readonly runtimeWarnings: string[] = []
  private readonly canUseTool: CanUseToolFn
  private readonly autoExtractMemories: boolean

  private runtimeState: RuntimeState | undefined
  private runtimeInitPromise: Promise<void> | undefined

  // 工具列表单次懒加载：并发调用共享同一个 Promise，解析后永久缓存
  private allToolsPromise: Promise<Tool[]> | undefined
  // fix ①: 同步供 toolNames() 使用的缓存副本，需在 refresh/dispose 时清理
  private cachedAllTools: Tool[] = []

  // agent 级 AbortController，用于工具解析等基础设施操作
  private readonly agentAbortController = new AbortController()

  // fix ④: 改为惰性初始化，仅在向后兼容 API 被调用时创建
  private _defaultSession: ConversationSession | undefined

  constructor(opts: AgentOptions) {
    this.opts = opts
    this.log =
      opts.log ??
      ((msg, level = 'info') => {
        if (level === 'debug' && !process.env.DEBUG) return
        const prefix = `[${level}]`.padEnd(7)
        console.error(`${prefix} ${msg}`)
      })
    this.canUseTool = opts.canUseTool ?? allowAllPermission
    this.autoExtractMemories = opts.autoExtractMemories ?? true
  }

  // fix ④: lazy getter，只在向后兼容方法被调用时才创建默认 session
  private get defaultSession(): ConversationSession {
    return (this._defaultSession ??= new ConversationSession(this.buildSessionDeps()))
  }

  // ─── 会话工厂 ──────────────────────────────────────────────────────────────

  /**
   * 创建一个独立的对话会话。多个会话可在同一 Agent 上完全并发运行。
   *
   * **生命周期约束**：session 通过闭包持有对本 Agent 基础设施的引用。
   * 调用 agent.drain() 处置 providers 后，所有由本 Agent 创建的 session
   * 均不应再被调用——后续工具解析调用将对已关闭的连接发起请求。
   */
  createSession(opts?: SessionOptions): ConversationSession {
    return new ConversationSession(this.buildSessionDeps(), opts)
  }

  private buildSessionDeps(): SessionDeps {
    return {
      cwd: this.opts.cwd,
      memoryDir: this.opts.memoryDir,
      log: this.log,
      canUseTool: this.canUseTool,
      maxTurns: this.opts.maxTurns ?? 10,
      autoExtractMemories: this.autoExtractMemories,
      turnsPerExtraction: this.opts.turnsPerExtraction ?? 1,
      onMemoriesSaved: this.opts.onMemoriesSaved,
      getAvailableSkills: async () => {
        await this.ensureRuntimeInitialized()
        return this.runtimeState!.availableSkills
      },
      getDefaultActiveSkills: async () => {
        await this.ensureRuntimeInitialized()
        return this.runtimeState!.activeSkills
      },
      getCapabilitiesForSkills: skills => this.getCapabilitiesForSkills(skills),
    }
  }

  // ─── 共享基础设施 ───────────────────────────────────────────────────────────

  /**
   * 为指定的活跃技能集合解析工具列表和 systemPrompt。
   * 基于缓存的工具列表做纯计算，可被多个 Session 并发调用。
   */
  private async getCapabilitiesForSkills(
    activeSkills: SkillDoc[],
  ): Promise<{ tools: Tool[]; systemPrompt: string }> {
    await this.ensureRuntimeInitialized()
    const allTools = await this.resolveAllTools()
    const tools = this.applySkillToolPolicy(allTools, activeSkills)
    const skillsSection = buildSkillsPromptSection(activeSkills)

    const systemPrompt = await buildSystemPrompt({
      memoryDir: this.opts.memoryDir,
      tools,
      agentName: this.opts.agentName,
      cwd: this.opts.cwd,
      extraSections: skillsSection ? [skillsSection] : undefined,
    })

    this.log(
      `[agent] capabilities resolved: tools=${tools.length}/${allTools.length}, skills=${activeSkills.length}`,
      'debug',
    )
    return { tools, systemPrompt }
  }

  // 工具列表懒加载：首次调用发起 I/O，并发调用共享同一 Promise
  private async resolveAllTools(): Promise<Tool[]> {
    if (!this.allToolsPromise) {
      this.allToolsPromise = this.doResolveAllTools()
    }
    return this.allToolsPromise
  }

  private async doResolveAllTools(): Promise<Tool[]> {
    const resolved = await resolveToolsFromProviders(this.runtimeState!.providers, {
      cwd: this.opts.cwd,
      memoryDir: this.opts.memoryDir,
      log: this.log,
      signal: this.agentAbortController.signal,
    })
    if (resolved.errors.length > 0) {
      for (const err of resolved.errors) {
        this.log(err, 'warn')
      }
    }
    this.cachedAllTools = resolved.tools
    this.log(`[agent] tools resolved: ${resolved.tools.length} tools`, 'info')
    return resolved.tools
  }

  private applySkillToolPolicy(tools: Tool[], activeSkills: SkillDoc[]): Tool[] {
    const state = this.runtimeState
    if (!state) return tools

    const allowlist = buildToolAllowlistFromSkills(activeSkills)
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

  // ─── 运行时初始化 ───────────────────────────────────────────────────────────

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
      providers.push(
        createMCPProvider({
          servers: mcpSettings.servers,
          allowTools: mcpSettings.allowedTools,
        }),
      )
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
    if (explicit && explicit.length > 0) return explicit.map((p: string) => resolve(p))
    const raw = process.env.SKILL_ROOTS?.trim()
    if (!raw) return []
    return raw
      .split(delimiter)
      .map((p: string) => p.trim())
      .filter(Boolean)
      .map((p: string) => resolve(p))
  }

  private resolveDefaultSkillIds(explicit?: string[]): string[] {
    if (explicit && explicit.length > 0) return explicit
    const raw = process.env.SKILLS?.trim()
    if (!raw) return []
    return raw
      .split(',')
      .map((x: string) => x.trim())
      .filter(Boolean)
  }

  // ─── 向后兼容 API（代理到默认 session）──────────────────────────────────────

  /** 上次 LLM 调用的 Token 用量（默认 session）。 */
  get lastUsage(): TokenUsage | undefined {
    return this.defaultSession.lastUsage
  }

  /** 执行一个完整的对话轮次（默认 session）。 */
  async executeTurn(userInput: string): Promise<QueryResult> {
    return this.defaultSession.executeTurn(userInput)
  }

  /** 向 agent 发送聊天消息并返回文本回复（默认 session）。 */
  async chat(userInput: string): Promise<string> {
    return this.defaultSession.chat(userInput)
  }

  /** 流式聊天（默认 session）。 */
  async *streamChat(
    userInput: string,
  ): AsyncGenerator<QueryStreamChunk, QueryResult> {
    const gen = this.defaultSession.streamChat(userInput)
    // fix ②: 消除 result 变量和非空断言，与 session.ts 保持一致
    for (;;) {
      const step = await gen.next()
      if (step.done) {
        return step.value
      }
      yield step.value
    }
  }

  /**
   * 强制重新解析工具列表和 systemPrompt。
   * 下次任意 session 调用 executeTurn/streamChat 时将重新构建能力快照。
   * fix ①: 同步清理 cachedAllTools，避免 toolNames() 返回过期数据
   */
  async refreshSystemPrompt(): Promise<void> {
    this.allToolsPromise = undefined
    this.cachedAllTools = [] // fix ①
    this.defaultSession.invalidateCapabilitiesCache()
  }

  /** 立即触发记忆提取（默认 session）。 */
  async extractMemoriesNow(): Promise<string[]> {
    return this.defaultSession.extractMemoriesNow()
  }

  /** 返回默认 session 的对话历史快照。 */
  historySnapshot(): Message[] {
    return this.defaultSession.historySnapshot()
  }

  /** 替换默认 session 的对话历史。 */
  replaceHistory(messages: Message[]): void {
    this.defaultSession.replaceHistory(messages)
  }

  /** 中止默认 session 当前操作。 */
  abort(): void {
    this.defaultSession.abort()
  }

  /** 返回默认 session 的消息数量。 */
  historyLength(): number {
    return this.defaultSession.historyLength()
  }

  /** 返回当前已解析的工具名称列表（工具未解析时返回空数组）。 */
  toolNames(): string[] {
    return this.cachedAllTools.map(t => t.name)
  }

  /** 返回 Agent 级别的默认活跃技能 ID 列表。 */
  activeSkillIds(): string[] {
    return this.runtimeState?.activeSkills.map(s => s.id) ?? []
  }

  /**
   * 等待默认 session 后台任务完成并释放所有 provider 资源。
   *
   * **调用后所有由本 Agent 创建的 session 均不可再使用。**
   * session 通过闭包持有对本 Agent providers 的引用，drain 后继续调用
   * 将对已关闭的连接发起工具解析，行为未定义。
   */
  async drain(timeoutMs?: number): Promise<void> {
    await this.defaultSession.drain(timeoutMs)
    await this.disposeProviders()
  }

  private async disposeProviders(): Promise<void> {
    if (!this.runtimeState) return
    // fix ①: 处置 providers 后清理工具缓存，释放引用、防止 toolNames() 返回僵尸数据
    this.cachedAllTools = []
    this.allToolsPromise = undefined
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
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback
  const value = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return fallback
  return fallback
}

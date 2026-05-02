/** 中文说明：核心 agent 模块。 */

import { delimiter, resolve } from 'path'
import { allowAllPermission } from './permissions.js'
import { runQueryLoop, type QueryResult, type StopHookFn } from './query.js'
import { callLLMStream, type LLMStreamChunk, type TokenUsage } from './llm.js'
import {
  initExtractMemories,
  type ExtractMemoriesController,
} from './extractMemories.js'
import { buildSystemPrompt } from './systemPrompt.js'
import type { CanUseToolFn, Message, Tool, ToolUseContext } from './types.js'
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

/** Agent 类：封装 agent 运行时核心逻辑，包括会话管理、工具调度、技能系统和记忆提取。 */
export class Agent {
  readonly opts: AgentOptions
  private tools: Tool[] = []
  private readonly extractor: ExtractMemoriesController
  private readonly history: Message[] = []
  private systemPrompt: string | undefined
  private readonly abortController = new AbortController()
  private readonly log: NonNullable<AgentOptions['log']>
  private readonly runtimeWarnings: string[] = []
  private readonly canUseTool: CanUseToolFn
  private readonly autoExtractMemories: boolean
  private lastSavedMemoryPaths: string[] = []
  /** 上次 LLM 调用的 Token 用量（流式模式填充） */
  public lastUsage: TokenUsage | undefined

  private runtimeState: RuntimeState | undefined
  private runtimeInitPromise: Promise<void> | undefined

  // 构造 Agent 实例，初始化日志记录器、权限函数和记忆提取器
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
    this.extractor = initExtractMemories({
      memoryDir: opts.memoryDir,
      turnsPerExtraction: opts.turnsPerExtraction ?? 1,
      onSaved: paths => {
        this.lastSavedMemoryPaths = [...paths]
        opts.onMemoriesSaved?.(paths)
      },
    })
  }

  // 确保运行时已初始化（懒加载，单次执行）
  private async ensureRuntimeInitialized(): Promise<void> {
    if (this.runtimeState) return
    if (!this.runtimeInitPromise) {
      this.runtimeInitPromise = this.initRuntime()
    }
    await this.runtimeInitPromise
  }

  // 初始化运行时环境：加载本地工具提供商、MCP 服务和技能
  private async initRuntime(): Promise<void> {
    const providers: CapabilityProvider[] = [createLocalToolsProvider()]

    if (this.opts.capabilityProviders && this.opts.capabilityProviders.length > 0) {
      providers.push(...this.opts.capabilityProviders)
    }

    const mcpSettings = this.opts.mcpSettings ?? (await loadMCPSettingsFromEnv())
    if (mcpSettings.enabled && mcpSettings.servers.length > 0) {
      providers.push(createMCPProvider({
        servers: mcpSettings.servers,
        allowTools: mcpSettings.allowedTools,
      }))
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

  // 解析技能目录根路径（支持显式传入或从环境变量读取）
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

  // 解析默认技能 ID 列表（支持显式传入或从环境变量 SKILLS 读取）
  private resolveDefaultSkillIds(explicit?: string[]): string[] {
    if (explicit && explicit.length > 0) return explicit
    const raw = process.env.SKILLS?.trim()
    if (!raw) return []
    return raw
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  }

  // 刷新工具和能力列表，并应用技能工具策略
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

  // 根据当前活跃技能的工具白名单过滤工具列表
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

  // 检测用户输入中的技能 @mention 并动态激活对应技能
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

  /** 重建系统提示词，包含最新的工具列表、技能和记忆文件。 */
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

  // 构建工具调用的上下文对象
  private buildContext(): ToolUseContext {
    return {
      cwd: this.opts.cwd,
      memoryDir: this.opts.memoryDir,
      log: this.log,
      signal: this.abortController.signal,
    }
  }

  /** 执行一个完整的对话轮次：处理技能、刷新提示词、运行查询循环。 */
  async executeTurn(userInput: string): Promise<QueryResult> {
    const skillChanged = await this.applySkillMentions(userInput)
    if (!this.systemPrompt || skillChanged) {
      await this.refreshSystemPrompt()
    }

    this.history.push(createUserMessage(userInput))
    const ctx = this.buildContext()

    const stopHooks: StopHookFn[] = this.autoExtractMemories
      ? [async ({ messages, context }) => {
          void this.extractor.run(messages, context)
        }]
      : []

    const result = await runQueryLoop({
      systemPrompt: this.systemPrompt!,
      messages: this.history,
      tools: this.tools,
      canUseTool: this.canUseTool,
      context: ctx,
      maxTurns: this.opts.maxTurns ?? 10,
      stopHooks,
    })

    while (this.history.length < result.messages.length) {
      this.history.push(result.messages[this.history.length]!)
    }

    return result
  }

  /** 向 agent 发送聊天消息并返回文本回复。 */
  async chat(userInput: string): Promise<string> {
    const result = await this.executeTurn(userInput)
    if (result.status === 'confirm_required') {
      throw new Error(`Human approval required: ${result.reason ?? 'This action requires review.'}`)
    }
    return result.finalMessage ? getText(result.finalMessage) : ''
  }

  /**
   * 流式聊天：逐步 yield LLM 响应块。
   *
   * 适用于需要实时展示输出文本的场景（如 SSE / WebSocket 推送）。
   * 注意：流式模式下不支持工具调用循环，如需工具调用请使用非流式 `chat()`。
   *
   * @example
   *   for await (const chunk of agent.streamChat('Hello')) {
   *     if (chunk.type === 'text_delta') process.stdout.write(chunk.text)
   *   }
   *   console.log('Tokens:', agent.lastUsage)
   */
  async *streamChat(userInput: string): AsyncGenerator<LLMStreamChunk, void> {
    const skillChanged = await this.applySkillMentions(userInput)
    if (!this.systemPrompt || skillChanged) {
      await this.refreshSystemPrompt()
    }

    this.history.push(createUserMessage(userInput))

    try {
      const gen = callLLMStream({
        systemPrompt: this.systemPrompt!,
        history: this.history,
        tools: this.tools,
        signal: this.abortController.signal,
      })

      let result
      while (true) {
        const { value, done } = await gen.next()
        if (done) {
          result = value
          break
        }
        yield value
      }

      if (result) {
        this.lastUsage = result.usage
        this.history.push(result.assistant)
      }
    } catch (err) {
      const errorMsg = `LLM stream error: ${(err as Error).message}`
      this.log(errorMsg, 'error')
      const errorMsg2_user: Message = {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        content: [{ type: 'text', text: errorMsg }],
        stopReason: 'error',
      }
      this.history.push(errorMsg2_user)
    }
  }

  /** 立即触发记忆提取并等待完成，返回本次保存的记忆文件路径。 */
  async extractMemoriesNow(): Promise<string[]> {
    this.lastSavedMemoryPaths = []
    if (this.history.length === 0) return []
    await this.extractor.run(this.historySnapshot(), this.buildContext())
    await this.extractor.drain(10_000)
    return [...this.lastSavedMemoryPaths]
  }

  /** 返回当前对话历史的快照副本。 */
  historySnapshot(): Message[] {
    return [...this.history]
  }

  /** 替换整个对话历史记录。 */
  replaceHistory(messages: Message[]): void {
    this.history.length = 0
    this.history.push(...messages)
  }

  /** 等待所有后台任务完成并释放资源。 */
  async drain(timeoutMs?: number): Promise<void> {
    await this.extractor.drain(timeoutMs)
    await this.disposeProviders()
  }

  // 释放所有工具提供商的资源
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

  /** 返回当前对话历史的消息数量。 */
  historyLength(): number {
    return this.history.length
  }

  /** 返回当前可用于工具调用的工具名称列表。 */
  toolNames(): string[] {
    return this.tools.map(t => t.name)
  }

  /** 返回当前活跃技能的 ID 列表。 */
  activeSkillIds(): string[] {
    if (!this.runtimeState) return []
    return this.runtimeState.activeSkills.map(s => s.id)
  }

  /** 中止当前所有正在运行的操作。 */
  abort(): void {
    this.abortController.abort()
  }
}

// 解析布尔类型的环境变量值
function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback
  const value = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false
  return fallback
}

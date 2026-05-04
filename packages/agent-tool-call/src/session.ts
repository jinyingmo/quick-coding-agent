import { randomUUID } from 'crypto'
import { createUserMessage, getText } from './types.js'
import {
  runQueryLoop,
  runQueryLoopStream,
  type QueryResult,
  type QueryStreamChunk,
  type StopHookFn,
} from './query.js'
import { initExtractMemories, type ExtractMemoriesController } from './extractMemories.js'
import { extractSkillMentions, selectSkills } from './skills/resolver.js'
import type { CanUseToolFn, LogLevel, Message, Tool, ToolUseContext } from './types.js'
import type { TokenUsage } from './llm.js'
import type { SkillDoc } from './skills/types.js'

/**
 * 由 Agent 注入的共享基础设施依赖。
 * 所有方法通过闭包惰性访问 Agent 内部状态，确保 Session 在 Agent 初始化完成前也能被同步创建。
 */
export type SessionDeps = {
  cwd: string
  memoryDir: string
  log: (msg: string, level?: LogLevel) => void
  canUseTool: CanUseToolFn
  maxTurns: number
  autoExtractMemories: boolean
  turnsPerExtraction: number
  onMemoriesSaved?: (paths: string[]) => void
  getAvailableSkills: () => Promise<SkillDoc[]>
  getDefaultActiveSkills: () => Promise<SkillDoc[]>
  getCapabilitiesForSkills: (activeSkills: SkillDoc[]) => Promise<{
    tools: Tool[]
    systemPrompt: string
  }>
}

export type SessionOptions = {
  sessionId?: string
  userId?: string
  workspaceId?: string
  initialHistory?: Message[]
}

/**
 * 独立的对话会话，持有单条对话线程的全部可变状态。
 *
 * 多个 ConversationSession 实例可以在同一个 Agent 上完全并发运行，
 * 因为它们之间没有任何共享可变状态：
 *   - history         — 本会话的消息记录
 *   - activeSkills    — 本会话当前激活的技能（从 Agent 默认值惰性初始化）
 *   - abortController — 本会话独立的取消信号
 *   - extractor       — 本会话独立的记忆提取状态机（含游标和节流计数）
 *
 * Agent 提供的工具解析和 systemPrompt 构建是无状态的纯计算，
 * 可被任意数量的 Session 并发调用。
 *
 * **单实例顺序语义**：同一 Session 实例应由单条调用链顺序使用
 * （一个 Session 对应一条对话线程）。需要真正并发时，请为每个线程创建独立的 Session。
 */
export class ConversationSession {
  readonly sessionId: string
  private history: Message[]
  private abortController: AbortController
  private readonly extractor: ExtractMemoriesController
  // fix ⑥: 改为 getter，防止外部直接写入
  private _lastUsage: TokenUsage | undefined

  // fix ③⑧: 单飞 Promise 缓存 + 重命名（ensureActiveSkills → getActiveSkills）
  private activeSkills: SkillDoc[] | undefined
  private activeSkillsPromise: Promise<SkillDoc[]> | undefined

  // fix ⑦: capabilities 单飞缓存
  private capabilitiesCache:
    | { tools: Tool[]; systemPrompt: string; skillHash: string }
    | undefined
  private capabilitiesFetchInFlight:
    | { promise: Promise<{ tools: Tool[]; systemPrompt: string }>; skillHash: string }
    | undefined

  private lastSavedPaths: string[] = []

  constructor(
    private readonly deps: SessionDeps,
    private readonly opts: SessionOptions = {},
  ) {
    this.sessionId = opts.sessionId ?? randomUUID()
    this.history = opts.initialHistory ? [...opts.initialHistory] : []
    this.abortController = new AbortController()
    this.extractor = initExtractMemories({
      memoryDir: deps.memoryDir,
      turnsPerExtraction: deps.turnsPerExtraction,
      onSaved: paths => {
        this.lastSavedPaths = paths
        deps.onMemoriesSaved?.(paths)
      },
    })
  }

  // fix ⑥: 只读 getter
  get lastUsage(): TokenUsage | undefined {
    return this._lastUsage
  }

  /**
   * 返回当前活跃技能，首次调用时从 Agent 默认值初始化。
   * 并发调用共享同一个初始化 Promise，不重复发起 I/O。
   * fix ③⑧
   */
  private getActiveSkills(): Promise<SkillDoc[]> {
    if (this.activeSkills !== undefined) {
      return Promise.resolve(this.activeSkills)
    }
    if (!this.activeSkillsPromise) {
      this.activeSkillsPromise = this.deps.getDefaultActiveSkills().then(skills => {
        this.activeSkills = skills
        return skills
      })
    }
    return this.activeSkillsPromise
  }

  private skillHash(skills: SkillDoc[]): string {
    return skills
      .map(s => s.id)
      .sort()
      .join(',')
  }

  /**
   * 解析当前技能对应的工具列表和 systemPrompt。
   * 同一 skillHash 的并发请求共享同一个 in-flight Promise，不重复构建。
   * fix ⑦
   */
  private resolveCapabilities(): Promise<{ tools: Tool[]; systemPrompt: string }> {
    return this.getActiveSkills().then(skills => {
      const hash = this.skillHash(skills)

      if (this.capabilitiesCache?.skillHash === hash) {
        return this.capabilitiesCache
      }

      if (this.capabilitiesFetchInFlight?.skillHash === hash) {
        return this.capabilitiesFetchInFlight.promise
      }

      const promise = this.deps.getCapabilitiesForSkills(skills).then(caps => {
        this.capabilitiesCache = { ...caps, skillHash: hash }
        if (this.capabilitiesFetchInFlight?.skillHash === hash) {
          this.capabilitiesFetchInFlight = undefined
        }
        return caps
      })

      this.capabilitiesFetchInFlight = { promise, skillHash: hash }
      return promise
    })
  }

  /** 使能力缓存失效，下次 turn 将重新构建 systemPrompt 和工具列表。 */
  invalidateCapabilitiesCache(): void {
    this.capabilitiesCache = undefined
    this.capabilitiesFetchInFlight = undefined // fix ⑦: 同时清除进行中的 fetch
  }

  private async applySkillMentions(userInput: string): Promise<void> {
    const mentioned = extractSkillMentions(userInput)
    if (mentioned.length === 0) return

    const [available, current] = await Promise.all([
      this.deps.getAvailableSkills(),
      this.getActiveSkills(), // fix ⑧
    ])
    const selection = selectSkills({ available, requestedIds: mentioned })

    if (selection.unknownRequested.length > 0) {
      this.deps.log(
        `[session:${this.sessionId}] unknown skill mentions: ${selection.unknownRequested.join(', ')}`,
        'warn',
      )
    }

    if (this.skillHash(current) === this.skillHash(selection.active)) return

    this.activeSkills = selection.active
    this.capabilitiesCache = undefined
    this.capabilitiesFetchInFlight = undefined // fix ⑦: 技能变更时同步清除进行中的 fetch
    this.deps.log(
      `[session:${this.sessionId}] skills: ${selection.active.map(s => s.id).join(', ') || '(none)'}`,
      'info',
    )
  }

  private buildContext(): ToolUseContext {
    return {
      cwd: this.deps.cwd,
      memoryDir: this.deps.memoryDir,
      sessionId: this.sessionId,
      userId: this.opts.userId,
      workspaceId: this.opts.workspaceId,
      log: this.deps.log,
      signal: this.abortController.signal,
    }
  }

  private makeStopHooks(): StopHookFn[] {
    if (!this.deps.autoExtractMemories) return []
    return [
      async ({ messages, context }) => {
        void this.extractor.run(messages, context)
      },
    ]
  }

  /** 执行一个完整的对话轮次（非流式）。 */
  async executeTurn(userInput: string): Promise<QueryResult> {
    await this.applySkillMentions(userInput)
    const { tools, systemPrompt } = await this.resolveCapabilities()
    const messages = [...this.history, createUserMessage(userInput)]

    const result = await runQueryLoop({
      systemPrompt,
      messages,
      tools,
      canUseTool: this.deps.canUseTool,
      context: this.buildContext(),
      maxTurns: this.deps.maxTurns,
      stopHooks: this.makeStopHooks(),
    })

    this.history = result.messages
    this._lastUsage = result.usage // fix ⑥
    return result
  }

  /** 发送消息并返回文本回复。 */
  async chat(userInput: string): Promise<string> {
    const result = await this.executeTurn(userInput)
    if (result.status === 'confirm_required') {
      throw new Error(
        `Human approval required: ${result.reason ?? 'This action requires review.'}`,
      )
    }
    return result.finalMessage ? getText(result.finalMessage) : ''
  }

  /**
   * 流式聊天：逐步 yield 响应块。
   *
   * 锁语义：本方法在流传输期间不持有任何全局锁。
   * 每个 Session 实例的 history/activeSkills 为独占状态，调用方应保证
   * 同一 Session 实例不被并发调用（即一个 Session 对应一条对话线程）。
   */
  async *streamChat(
    userInput: string,
  ): AsyncGenerator<QueryStreamChunk, QueryResult> {
    await this.applySkillMentions(userInput)
    const { tools, systemPrompt } = await this.resolveCapabilities()
    const messages = [...this.history, createUserMessage(userInput)]

    const gen = runQueryLoopStream({
      systemPrompt,
      messages,
      tools,
      canUseTool: this.deps.canUseTool,
      context: this.buildContext(),
      maxTurns: this.deps.maxTurns,
      stopHooks: this.makeStopHooks(),
    })

    // fix ②: 消除 result 变量，用 for(;;) + return 直接返回，无需非空断言
    for (;;) {
      const step = await gen.next()
      if (step.done) {
        this.history = step.value.messages
        this._lastUsage = step.value.usage // fix ⑥
        return step.value
      }
      yield step.value
    }
  }

  /** 立即触发记忆提取并等待完成，返回本次保存的记忆文件路径。 */
  async extractMemoriesNow(): Promise<string[]> {
    if (this.history.length === 0) return []
    this.lastSavedPaths = []
    await this.extractor.run(this.historySnapshot(), this.buildContext())
    await this.extractor.drain(10_000)
    return [...this.lastSavedPaths]
  }

  /** 返回当前对话历史的快照副本。 */
  historySnapshot(): Message[] {
    return [...this.history]
  }

  /** 替换整个对话历史，同时使能力缓存失效。 */
  replaceHistory(messages: Message[]): void {
    this.history = [...messages]
    this.invalidateCapabilitiesCache()
  }

  /** 中止本会话当前正在进行的操作，并创建新的 AbortController。 */
  abort(): void {
    this.abortController.abort()
    this.abortController = new AbortController()
  }

  /** 等待本会话所有后台记忆提取任务完成。 */
  async drain(timeoutMs?: number): Promise<void> {
    await this.extractor.drain(timeoutMs)
  }

  historyLength(): number {
    return this.history.length
  }

  async activeSkillIds(): Promise<string[]> {
    const skills = await this.getActiveSkills() // fix ⑧
    return skills.map(s => s.id)
  }
}

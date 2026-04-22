/**
 * High-level Agent orchestrator.
 *
 * Wires together:
 *   - System prompt (memory section + tool catalog)
 *   - Tool registry
 *   - Permission policy (allow-all for the main agent)
 *   - Stop hook → background memory extraction
 *
 * Each call to `chat(userInput)` runs ONE full query loop and returns the
 * final assistant reply. The conversation history is retained inside the
 * Agent instance so subsequent `chat()` calls extend the same session.
 */

import { allowAllPermission } from './permissions.js'
import { runQueryLoop, type StopHookFn } from './query.js'
import { ALL_TOOLS } from './tools/index.js'
import {
  initExtractMemories,
  type ExtractMemoriesController,
} from './extractMemories.js'
import { buildSystemPrompt } from './systemPrompt.js'
import type { Message, Tool, ToolUseContext } from './types.js'
import { createUserMessage, getText } from './types.js'

export type AgentOptions = {
  cwd: string
  memoryDir: string
  agentName?: string
  /** Throttle for the background extractor. */
  turnsPerExtraction?: number
  maxTurns?: number
  log?: ToolUseContext['log']
  onMemoriesSaved?: (paths: string[]) => void
}

export class Agent {
  readonly opts: AgentOptions
  private readonly tools: Tool[] = ALL_TOOLS
  private readonly extractor: ExtractMemoriesController
  private readonly history: Message[] = []
  private systemPrompt: string | undefined
  private readonly abortController = new AbortController()
  private readonly log: NonNullable<AgentOptions['log']>

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

  /**
   * Rebuild the system prompt — call this when memory contents change
   * out-of-band so the next turn sees the fresh MEMORY.md.
   */
  async refreshSystemPrompt(): Promise<void> {
    this.systemPrompt = await buildSystemPrompt({
      memoryDir: this.opts.memoryDir,
      tools: this.tools,
      agentName: this.opts.agentName,
      cwd: this.opts.cwd,
    })
  }

  /** Run one full turn for the given user input. Returns the assistant reply text. */
  async chat(userInput: string): Promise<string> {
    if (!this.systemPrompt) {
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
  }

  /** Number of messages in the conversation history (for display). */
  historyLength(): number {
    return this.history.length
  }

  abort(): void {
    this.abortController.abort()
  }
}

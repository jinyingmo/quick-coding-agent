/**
 * Background memory extraction.
 *
 * Mirrors `src/services/extractMemories/extractMemories.ts` of the parent
 * project. This file deliberately preserves the same closure-state pattern so
 * the demo demonstrates not just the *prompt* but the *scheduling discipline*
 * that makes the production system robust:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  initExtractMemories() returns:                                     │
 *   │     • run(messages, ctx)        — fire from the queryLoop stopHook  │
 *   │     • drain(timeoutMs)          — await pending forks before exit   │
 *   │                                                                      │
 *   │  Closure state:                                                      │
 *   │     lastMemoryMessageUuid       — cursor advanced after each run    │
 *   │     turnsSinceLastExtraction    — throttle (every N turns)          │
 *   │     inProgress + pendingContext — single-flight + trailing run      │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Per-turn flow:
 *   1. Skip if main agent already wrote into memoryDir (mutual exclusion)
 *   2. Throttle: only run every N eligible turns
 *   3. Fork an extractor subagent restricted to memoryDir writes
 *   4. After it terminates, advance the cursor and emit the "Saved N" notice
 */

import {
  formatMemoryManifest,
  scanMemoryFiles,
} from './memory/index.js'
import {
  extractWrittenPaths,
  hasMemoryWritesSince,
  runForkedAgent,
} from './forkedAgent.js'
import { restrictToMemoryDirPermission } from './permissions.js'
import { ALL_TOOLS } from './tools/index.js'
import type { Message, ToolUseContext } from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// Prompt building
// ────────────────────────────────────────────────────────────────────────────

const SAVE_INSTRUCTIONS = `## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g. \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations}}
type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project, structure as: rule/fact, then **Why:** and **How to apply:** lines}}
\`\`\`

**Step 2** — add a pointer in \`MEMORY.md\` (one line: \`- [Title](file.md) — one-line hook\`).

Rules:
- Organize semantically by topic, not chronologically.
- Update or remove memories that turned out wrong or outdated.
- Do not write duplicate memories. Check the existing file list and prefer Edit/Write to an existing file.
- DO NOT save code patterns, file paths, git history, or anything derivable from the current project state.
- DO NOT save in-progress task details or temporary conversation context.`

function buildExtractPrompt(
  newMessageCount: number,
  manifest: string,
  memoryDir: string,
): string {
  const manifestSection =
    manifest.length > 0
      ? `\n\n## Existing memory files\n\n${manifest}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : ''
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update the persistent memory directory at \`${memoryDir}\`.`,
    '',
    'Available tools: `read_file`, `list_dir`, `write_file` (only for paths inside the memory directory). Other writes will be denied. Do NOT call tools to grep/verify source code — only use evidence from the messages above.',
    '',
    'Efficient strategy: turn 1 — issue all `read_file` calls in parallel for every memory file you might update; turn 2 — issue all `write_file` calls in parallel.',
    '',
    'Save only memory of type `user`, `feedback`, `project`, or `reference`. If nothing in this batch is worth saving, just respond "no memories worth saving" and stop.',
    manifestSection,
    '',
    SAVE_INSTRUCTIONS,
  ].join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Public init
// ────────────────────────────────────────────────────────────────────────────

export type ExtractMemoriesController = {
  /** Stop-hook entry point — call from `runQueryLoop`'s stopHooks array. */
  run: (messages: Message[], ctx: ToolUseContext) => Promise<void>
  /** Await any in-flight extraction (with a soft timeout). */
  drain: (timeoutMs?: number) => Promise<void>
  /** True when an extraction is currently executing. */
  isInProgress: () => boolean
}

export type ExtractMemoriesConfig = {
  /** Memory directory (defaults to ctx.memoryDir at run() time). */
  memoryDir?: string
  /** Throttle: only run every N eligible turns. Default 1 (every turn). */
  turnsPerExtraction?: number
  /** Hard cap on subagent turns. Default 5 — same as parent project. */
  maxTurns?: number
  /** Notification callback fired after a successful extraction (e.g. for the CLI). */
  onSaved?: (memoryPaths: string[]) => void
}

/**
 * Build a fresh controller with its own closure state. Tests in the parent
 * project re-init in `beforeEach` for the same reason.
 */
export function initExtractMemories(
  cfg: ExtractMemoriesConfig = {},
): ExtractMemoriesController {
  const turnsPerExtraction = cfg.turnsPerExtraction ?? 1
  const maxTurns = cfg.maxTurns ?? 5

  // Closure-scoped mutable state — see file header.
  let lastMemoryMessageUuid: string | undefined
  let turnsSinceLastExtraction = 0
  let inProgress = false
  let pendingContext: { messages: Message[]; ctx: ToolUseContext } | undefined
  const inFlight = new Set<Promise<void>>()

  function countModelVisibleSince(messages: Message[], uuid: string | undefined): number {
    if (uuid === undefined) return messages.length
    let started = false
    let n = 0
    for (const m of messages) {
      if (!started) {
        if (m.uuid === uuid) started = true
        continue
      }
      n++
    }
    return started ? n : messages.length
  }

  async function runExtraction(
    messages: Message[],
    ctx: ToolUseContext,
    isTrailingRun: boolean,
  ): Promise<void> {
    const memoryDir = cfg.memoryDir ?? ctx.memoryDir
    const newCount = countModelVisibleSince(messages, lastMemoryMessageUuid)

    // ── Mutual exclusion: main agent already wrote memories this range ──
    if (hasMemoryWritesSince(messages, lastMemoryMessageUuid, memoryDir)) {
      ctx.log(
        '[extractMemories] skipping — main agent already wrote to memory directory',
        'debug',
      )
      const last = messages.at(-1)
      if (last) lastMemoryMessageUuid = last.uuid
      return
    }

    // ── Throttle ──
    if (!isTrailingRun) {
      turnsSinceLastExtraction++
      if (turnsSinceLastExtraction < turnsPerExtraction) {
        ctx.log(
          `[extractMemories] throttled — ${turnsSinceLastExtraction}/${turnsPerExtraction} turns`,
          'debug',
        )
        return
      }
    }
    turnsSinceLastExtraction = 0

    inProgress = true
    const startedAt = Date.now()
    try {
      ctx.log(
        `[extractMemories] starting — ${newCount} new messages, memoryDir=${memoryDir}`,
        'info',
      )

      const headers = await scanMemoryFiles(memoryDir)
      const manifest = formatMemoryManifest(headers)
      const prompt = buildExtractPrompt(newCount, manifest, memoryDir)

      // We don't have the parent's exact systemPrompt available here — use
      // a minimal one. In the parent codebase, runForkedAgent reuses the
      // parent's full system prompt via cacheSafeParams; for the demo we
      // just declare the role.
      const result = await runForkedAgent({
        parentSystemPrompt:
          'You are an autonomous subagent. Follow the user message exactly. Use tools efficiently and stop as soon as the task is done.',
        parentMessages: messages,
        tools: ALL_TOOLS,
        canUseTool: restrictToMemoryDirPermission(memoryDir),
        parentContext: ctx,
        prompt,
        maxTurns,
        forkLabel: 'extract_memories',
      })

      const written = extractWrittenPaths(result.messages)
      const memoryPaths = written.filter(p => !p.endsWith('MEMORY.md'))

      const last = messages.at(-1)
      if (last) lastMemoryMessageUuid = last.uuid

      ctx.log(
        `[extractMemories] done in ${result.turns} turns, ${Date.now() - startedAt}ms — wrote ${written.length} files (${memoryPaths.length} memories + ${
          written.length - memoryPaths.length
        } index update)`,
        'info',
      )

      if (memoryPaths.length > 0) {
        cfg.onSaved?.(memoryPaths)
      }
    } catch (err) {
      ctx.log(`[extractMemories] error: ${(err as Error).message}`, 'warn')
    } finally {
      inProgress = false

      // Trailing run: drain any context that arrived during this run.
      const trailing = pendingContext
      pendingContext = undefined
      if (trailing) {
        ctx.log('[extractMemories] running trailing extraction', 'debug')
        await runExtraction(trailing.messages, trailing.ctx, true)
      }
    }
  }

  async function run(messages: Message[], ctx: ToolUseContext): Promise<void> {
    if (ctx.agentId) {
      ctx.log('[extractMemories] skip — running inside a subagent', 'debug')
      return
    }

    if (inProgress) {
      ctx.log('[extractMemories] coalesced — extraction already in progress', 'debug')
      pendingContext = { messages, ctx }
      return
    }

    const p = runExtraction(messages, ctx, false)
    inFlight.add(p)
    try {
      await p
    } finally {
      inFlight.delete(p)
    }
  }

  async function drain(timeoutMs = 60_000): Promise<void> {
    if (inFlight.size === 0) return
    await Promise.race([
      Promise.all(inFlight).catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs).unref()),
    ])
  }

  return { run, drain, isInProgress: () => inProgress }
}

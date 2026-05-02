/** 中文说明：核心 agent 模块。 */

/**
 * Scripted (no-API) demonstration.
 *
 * Replays a hand-authored conversation through the SAME query loop and
 * extractor used by the live REPL. Lets reviewers verify:
 *
 *   - Tool dispatch and tool_result wiring
 *   - The "stop hook fires when no tool_use" terminal condition
 *   - The extractor's permission policy (forked agent's denied non-memory writes)
 *   - The "main agent already wrote → extractor skips" mutual-exclusion path
 *
 * No LLM_API_KEY required.
 */

import { resolve } from 'path'
import { initExtractMemories } from './extractMemories.js'
import { restrictToMemoryDirPermission } from './permissions.js'
import { runQueryLoop } from './query.js'
import { ALL_TOOLS, findToolByName } from './tools/index.js'
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseContext,
} from './types.js'
import { createAssistantMessage, createUserMessage } from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// Mini "model" — replays a deterministic sequence of assistant turns.
// Each call returns the next pre-baked AssistantMessage.
// ────────────────────────────────────────────────────────────────────────────

// 预设模型类：按固定顺序回放预定义的 AssistantMessage 序列
class CannedModel {
  private idx = 0
  // 构造预设模型，接收预定义的轮次消息数组
  constructor(private readonly turns: AssistantMessage[]) {}

  // 返回下一个预设的 AssistantMessage，耗尽时返回 end_turn
  next(): AssistantMessage {
    if (this.idx >= this.turns.length) {
      return createAssistantMessage(
        [{ type: 'text', text: '(canned model exhausted — emitting end_turn)' }],
        'end_turn',
      )
    }
    return this.turns[this.idx++]!
  }
}

// Patch `callLLM` for the scripted demo by injecting our own queryLoop wrapper
// that replaces the LLM call with the canned model.
// 运行预设脚本化对话循环：用 CannedModel 替代真实 LLM 调用
async function runScriptedLoop(params: {
  systemPrompt: string
  initialMessage: Message
  canned: CannedModel
  tools: Tool[]
  context: ToolUseContext
  canUseTool: ReturnType<typeof restrictToMemoryDirPermission> | undefined
  label: string
  stopHook?: (messages: Message[], ctx: ToolUseContext) => Promise<void> | void
  maxTurns?: number
}): Promise<Message[]> {
  const messages: Message[] = [params.initialMessage]
  const canUse = params.canUseTool ?? (await import('./permissions.js')).allowAllPermission
  const maxTurns = params.maxTurns ?? 5

  for (let turn = 0; turn < maxTurns; turn++) {
    const assistant = params.canned.next()
    messages.push(assistant)
    params.context.log(
      `[${params.label}] turn ${turn + 1}: assistant emitted ${assistant.content.length} block(s) (stop=${assistant.stopReason})`,
      'info',
    )

    const toolUses = assistant.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    )
    if (toolUses.length === 0) break

    const resultBlocks: ToolResultBlock[] = []
    for (const toolUse of toolUses) {
      const tool = findToolByName(toolUse.name)
      if (!tool) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        })
        continue
      }
      const perm = await canUse(tool, toolUse.input, params.context)
      if (perm.behavior === 'deny') {
        params.context.log(
          `[${params.label}]   ↳ DENY ${tool.name}: ${perm.message}`,
          'warn',
        )
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: perm.message,
          is_error: true,
        })
        continue
      }
      const parsed = tool.inputSchema.safeParse(perm.updatedInput)
      if (!parsed.success) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Invalid input: ${parsed.error.message}`,
          is_error: true,
        })
        continue
      }
      const result = await tool.call(parsed.data, params.context)
      params.context.log(
        `[${params.label}]   ↳ EXEC ${tool.name} → ${result.isError ? 'error' : 'ok'} (${result.display.length} chars)`,
        'info',
      )
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.display,
        is_error: result.isError,
      })
    }
    messages.push(createUserMessage(resultBlocks as ContentBlock[]))
  }

  if (params.stopHook) {
    await params.stopHook(messages, params.context)
  }
  return messages
}

// ────────────────────────────────────────────────────────────────────────────
// The actual scripted scenario
// ────────────────────────────────────────────────────────────────────────────

/** 运行脚本化演示：执行三个测试场景，验证工具调度、权限策略和错误处理。 */
export async function runScripted(memoryDir: string): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  Scripted demo — exercising the agent loop end-to-end')
  console.log(`  memoryDir = ${memoryDir}`)
  console.log('══════════════════════════════════════════════════════════════\n')

  const log: ToolUseContext['log'] = (msg, level = 'info') => {
    if (level === 'debug' && !process.env.DEBUG) return
    console.log(`  ${level.toUpperCase().padEnd(5)} ${msg}`)
  }

  const ctx: ToolUseContext = {
    cwd: process.cwd(),
    memoryDir,
    log,
    signal: new AbortController().signal,
  }

  // ── Scenario 1: main agent uses search_memory + answers, then extractor fires
  console.log('▶ Scenario 1: main agent searches memory, answers, then extractor fires\n')

  const userMsg1 = createUserMessage(
    'Hi! Quick question: how do I verify changes to the database layer are safe?',
  )

  const mainCanned = new CannedModel([
    createAssistantMessage(
      [
        { type: 'text', text: 'Let me check what we already know about testing.' },
        {
          type: 'tool_use',
          id: 'tu_search_1',
          name: 'search_memory',
          input: { query: 'how to verify changes are safe — testing policy' },
        },
      ],
      'tool_use',
    ),
    createAssistantMessage(
      [
        {
          type: 'text',
          text:
            'Based on the team feedback memory: integration tests must hit a real database (no mocks). Run the integration test suite and check the migration on a staging copy before merging.',
        },
      ],
      'end_turn',
    ),
  ])

  const extractor = initExtractMemories({
    memoryDir,
    onSaved: paths => log(`SAVED memories: ${paths.join(', ')}`),
  })

  const allMessages: Message[] = [userMsg1]
  for (const m of await runScriptedLoop({
    systemPrompt: '(scripted system prompt)',
    initialMessage: userMsg1,
    canned: mainCanned,
    tools: ALL_TOOLS,
    context: ctx,
    canUseTool: undefined, // main agent: allow-all
    label: 'main',
    stopHook: async (msgs, c) => {
      log('stop hook → invoking extractor (fire-and-forget pattern)')
      // Inline await for the demo so output is deterministic.
      await extractor.run(msgs, c)
    },
  })) {
    if (allMessages.indexOf(m) === -1) allMessages.push(m)
  }

  await extractor.drain(5_000)

  // ── Scenario 2: extractor permission policy — denies a write outside memoryDir
  console.log('\n▶ Scenario 2: forked extractor tries to write outside memoryDir → DENY\n')

  const extractorCanned = new CannedModel([
    createAssistantMessage(
      [
        { type: 'text', text: 'I will save a project note and try a forbidden write.' },
        {
          type: 'tool_use',
          id: 'tu_w_inside',
          name: 'write_file',
          input: {
            file_path: resolve(memoryDir, 'project_demo_run.md'),
            content:
              '---\nname: Demo agent run\ndescription: A scripted demo executed the agent loop end-to-end\ntype: project\n---\n\nThe scripted demo ran end-to-end and verified tool dispatch + extractor permission policy.\n',
          },
        },
        {
          type: 'tool_use',
          id: 'tu_w_outside',
          name: 'write_file',
          input: {
            file_path: resolve(process.cwd(), 'pwned.txt'),
            content: 'should never be written',
          },
        },
      ],
      'tool_use',
    ),
    createAssistantMessage(
      [{ type: 'text', text: 'Done with what was permitted; the rogue write was denied.' }],
      'end_turn',
    ),
  ])

  const extractorCtx: ToolUseContext = {
    ...ctx,
    agentId: 'scripted_extractor',
    log: (m, lvl) => log(`[scripted_extractor] ${m}`, lvl),
  }

  await runScriptedLoop({
    systemPrompt: '(scripted extractor system prompt)',
    initialMessage: createUserMessage(
      'You are the memory extractor. Try to save one project memory and one forbidden file.',
    ),
    canned: extractorCanned,
    tools: ALL_TOOLS,
    context: extractorCtx,
    canUseTool: restrictToMemoryDirPermission(memoryDir),
    label: 'extractor',
  })

  // ── Scenario 3: queryLoop integration with real LLM-shaped runner
  // (re-run scenario 1 inputs through runQueryLoop just to prove the wiring,
  // but with a stub that throws — demonstrates graceful error handling.)
  console.log('\n▶ Scenario 3: runQueryLoop without an API key — graceful error path\n')

  try {
    delete process.env.LLM_API_KEY
    delete process.env.KIMI_API_KEY
    await runQueryLoop({
      systemPrompt: '(no-key system prompt)',
      messages: [createUserMessage('Trigger a real LLM call without an API key.')],
      tools: ALL_TOOLS,
      canUseTool: (await import('./permissions.js')).allowAllPermission,
      context: ctx,
      maxTurns: 1,
    })
  } catch {
    // runQueryLoop swallows LLM errors and stamps stopReason='error'; we
    // print the absorbed result via the logger above.
  }

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  Scripted demo complete.')
  console.log('  Inspect the memory directory to see what was saved:')
  console.log(`    ls -la ${memoryDir}`)
  console.log('══════════════════════════════════════════════════════════════\n')
}

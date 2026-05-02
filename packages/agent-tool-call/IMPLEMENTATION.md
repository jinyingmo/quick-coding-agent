# Agent Tool-Call Demo — 实现解析

本文档详细拆解 `packages/agent-tool-call` 的每个模块，对应映射到主项目
`claude-code-source-code` 中的实现，方便对照源码精读。

---

## 一、整体架构

```
                         ┌─────────────┐
        user ──────────► │   Agent     │  (src/agent.ts)
                         └──────┬──────┘
                                │ chat()
                                ▼
                  ┌──────────────────────────┐
                  │     runQueryLoop         │  (src/query.ts)
                  │  ┌────────────────────┐  │
                  │  │  callLLM (Kimi)    │  │  src/llm.ts
                  │  └─────────┬──────────┘  │
                  │            ▼             │
                  │   getToolUses(reply)     │
                  │       │            ▲     │
                  │       ▼            │     │
                  │  Promise.all(      │     │
                  │   executeOne()→  ──┘     │
                  │   permission gate +      │  src/permissions.ts
                  │   tool.call()            │  src/tools/*
                  │  )                       │
                  └────────────┬─────────────┘
                               │ end_turn (no tool_use)
                               ▼
                  ┌──────────────────────────┐
                  │   stop hooks (parallel)  │
                  │  • extractMemories       │  src/extractMemories.ts
                  │     └─ runForkedAgent ──►│  src/forkedAgent.ts
                  │        sub-loop with     │      → runQueryLoop
                  │        canUseTool=       │        (recursive!)
                  │        memoryDir-only    │
                  └──────────────────────────┘
```

主循环和子 Agent 调用的是**同一个 `runQueryLoop`**——这是 Claude Code 真实
代码的关键设计：fork 不是另写一套循环，而是改 `canUseTool` + `prompt` +
`isForkedAgent` 标志。

---

## 二、目录与模块对应

```
src/
├── types.ts            — 消息 / 内容块 / Tool / ToolUseContext 接口
├── tools/
│   ├── readFile.ts     — read_file       (isReadOnly: true)
│   ├── writeFile.ts    — write_file      (isReadOnly: false → 受权限约束)
│   ├── listDir.ts      — list_dir        (isReadOnly: true)
│   ├── searchMemory.ts — search_memory   (调用 memory-system 的 findRelevantMemories)
│   └── index.ts        — ALL_TOOLS, findToolByName
├── permissions.ts      — allowAllPermission, restrictToMemoryDirPermission
├── llm.ts              — Moonshot/Kimi 客户端 + JSON Schema 转换
├── query.ts            — runQueryLoop 主循环
├── forkedAgent.ts      — runForkedAgent + hasMemoryWritesSince (互斥)
├── extractMemories.ts  — initExtractMemories（节流 + 单飞 + drain）
├── systemPrompt.ts     — buildSystemPrompt（注入 buildMemoryPrompt）
├── agent.ts            — Agent 类（封装历史 + stop hook）
├── scripted.ts         — 离线 3 场景演示（CannedModel）
└── cli.ts              — CLI 入口（--scripted / --repl）
```

---

## 三、核心模块详解

### 3.1 `types.ts` — 内部类型系统

完全模仿主项目 SDK 的形状，这样把代码读懂之后切回主仓不会有概念迁移成本：

```typescript
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export type Message = UserMessage | AssistantMessage   // 注意：assistant 没有 tool_result

export type Tool<I extends z.ZodType, O = unknown> = {
  readonly name: string
  readonly description: string
  readonly inputSchema: I            // zod schema
  isReadOnly(input: z.infer<I>): boolean
  call(input: z.infer<I>, ctx: ToolUseContext): Promise<ToolResult<O>>
}

export type ToolUseContext = {
  cwd: string
  memoryDir: string
  agentId?: string                   // 主 agent 时不设置；fork 时是 'extract_memories-xxx'
  log: (msg: string, level?: LogLevel) => void
  signal: AbortSignal
}

export type CanUseToolFn = (
  tool: Tool, input: Record<string, unknown>, ctx: ToolUseContext
) => Promise<PermissionResult>
```

**设计要点**：

- `ToolUseContext` 把 `agentId` 当作"我是不是 fork 出来的"的 sentinel，
  和主项目一致。`extractMemories` 用 `ctx.agentId === undefined` 判定自己
  应不应该作为 stop hook 触发。
- `tool.isReadOnly(input)` 是个 **per-input** 的回调，因为有些工具的安全
  性取决于参数（例如 bash 的命令字串）。这里的 4 个工具实现都很简单，但
  接口照搬了主项目的形状。

对应主项目：`src/Tool.ts` (整套 SDK 类型) + `src/types/agent.ts`。

---

### 3.2 `src/tools/*` — 4 个最小可用工具

| 工具 | 只读？ | 用来演示 |
|---|---|---|
| `read_file` | ✅ | 只读工具一律豁免权限策略 |
| `write_file` | ❌ | 写工具会被 `restrictToMemoryDirPermission` 拦截 |
| `list_dir` | ✅ | 多工具并行执行的样例 |
| `search_memory` | ✅ | **关键**：直接代理内置 memory 模块的 `findRelevantMemories`，把记忆系统真的接进去 |

`search_memory` 现在直接桥接到本包内置的 memory 子系统：

```typescript
import { findRelevantMemories } from '../memory/index.js'

async call(input, ctx) {
  const result = await findRelevantMemories(input.query, ctx.memoryDir, {
    signal: ctx.signal,
  })
  // 截断每个 hit 的内容到 max_snippet_chars，避免污染上下文
  const memories = result.memories.map(m => ({
    filename: m.filename,
    snippet: m.content.length > maxChars
      ? m.content.slice(0, maxChars) + '\n…(truncated)'
      : m.content,
  }))
  return { data: { memories }, display: ... }
}
```

模型决定何时调用、查什么、要多长的 snippet——这是 Claude Code "memory access
on demand" 的精神。

对应主项目：`src/tools/MemoryRetrievalTool/`、`src/tools/FileEditTool/` 等。

---

### 3.3 `permissions.ts` — `CanUseToolFn` 的两个实现

权限策略是 Claude Code 安全模型的核心抽象。这里给出两种最常见的策略：

**1. 主 agent 用：全部放行**

```typescript
export const allowAllPermission: CanUseToolFn = async (_tool, input) => ({
  behavior: 'allow',
  updatedInput: input,
})
```

**2. 后台抽取器用：只能写到 `memoryDir`**

```typescript
export function restrictToMemoryDirPermission(memoryDir: string): CanUseToolFn {
  const memRoot = resolve(memoryDir) + '/'
  return async function canUseTool(tool, input, ctx) {
    // 1. 校验 schema —— 失败直接 deny
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) return { behavior: 'deny', message: ... }

    // 2. 只读工具一律放行
    if (tool.isReadOnly(parsed.data)) return { behavior: 'allow', updatedInput: input }

    // 3. write_file：file_path 必须落在 memRoot 内
    if (tool.name === 'write_file') {
      const target = resolve((parsed.data as { file_path: string }).file_path)
      if (!(target + '/').startsWith(memRoot) && target !== memRoot.slice(0, -1)) {
        ctx.log(`denied write_file write to ${target} (outside ${memRoot})`, 'warn')
        return { behavior: 'deny', message:
          `Write denied: ${target} is outside the auto-memory directory ${memRoot}. ` +
          `Background memory extraction can only write inside the memory directory.`
        }
      }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}
```

**关键点**：`deny` 不是抛错，而是返回**结构化结果**。`runQueryLoop` 会把
deny 信息塞回模型作为 `tool_result`，模型可以在后续 turn 里调整自己的策略
（例如换个路径、放弃这个写入）。这就是 Claude Code 中 "hallucinate-into-the-
guardrail" 设计：不要让模型瞎转，而是让它**学到**什么是不允许的。

对应主项目：`src/permissions.ts` + 各个 hook 里的 `canUseTool` 工厂。

---

### 3.4 `query.ts` — `runQueryLoop` 主循环

这是整个 demo 的心脏。代码不长（≈140 行），但它对应主项目 `src/query.ts`
里成百行的 generator/state-machine 的简化版。逻辑：

```typescript
export async function runQueryLoop(params: QueryParams): Promise<QueryResult> {
  const messages = [...params.messages]
  for (let turn = 1; turn <= params.maxTurns; turn++) {
    if (params.context.signal.aborted) break

    // 1. LLM call
    const assistant = await callLLM({
      systemPrompt: params.systemPrompt,
      history: messages,
      tools: params.tools,
      config: llmConfig,
      signal: params.context.signal,
    })
    messages.push(assistant)

    // 2. Pull tool_use blocks
    const toolUses = getToolUses(assistant)
    if (toolUses.length === 0) break  // 模型给出最终回复 → 退出循环

    // 3. Run tool_use in PARALLEL
    const resultBlocks = await Promise.all(toolUses.map(tu =>
      executeOne(tu, params.tools, params.canUseTool, params.context),
    ))

    // 4. Stitch results back as a single user-role message
    messages.push(createUserMessage(resultBlocks))
  }

  // 5. Stop hooks — only for the *outermost* loop, not for fork sub-loops
  if (!params.isForkedAgent) {
    for (const hook of params.stopHooks ?? []) {
      try { await hook({ messages, context: params.context }) }
      catch (err) { params.context.log(`stop hook error: ${err}`, 'error') }
    }
  }

  return { messages, finalMessage: messages[messages.length - 1]! }
}
```

`executeOne` 把权限校验和工具执行串起来：

```typescript
async function executeOne(tu, tools, canUseTool, ctx): Promise<ToolResultBlock> {
  const tool = findToolByName(tu.name)
  if (!tool) return errBlock(tu.id, 'Unknown tool')

  // 校验
  const parsed = tool.inputSchema.safeParse(tu.input)
  if (!parsed.success) return errBlock(tu.id, `Invalid input: …`)

  // 权限
  const decision = await canUseTool(tool, tu.input, ctx)
  if (decision.behavior === 'deny') {
    ctx.log(`  ↳ DENY ${tool.name}: ${decision.message}`, 'warn')
    return errBlock(tu.id, decision.message)
  }

  // 执行
  try {
    const result = await tool.call(decision.updatedInput, ctx)
    return { type: 'tool_result', tool_use_id: tu.id, content: result.display, is_error: !!result.isError }
  } catch (err) {
    return errBlock(tu.id, (err as Error).message)
  }
}
```

**3 个细节值得关注**：

1. **并行执行**：模型一次产出 `[search_memory, list_dir, read_file]` 时，
   三者并行 await。Claude Code 真的这么做。
2. **权限校验在工具执行前**：不在 LLM 之前（无法预测 tool_use），不在工具
   实现里（重复编码）。
3. **`isForkedAgent` 抑制 stop hook**：否则会出现"extractor 的 extractor
   的 extractor"无限套娃。

对应主项目：`src/query.ts` 的 `query` async generator + `runToolUseSimple`。

---

### 3.5 `forkedAgent.ts` — Fork 一个子 Agent

```typescript
export async function runForkedAgent(params: ForkedAgentParams): Promise<QueryResult> {
  const agentId = `${params.forkLabel}-${randomUUID().slice(0, 8)}`
  const subContext: ToolUseContext = {
    ...params.parentContext,
    agentId,
    log: (msg, lvl) => params.parentContext.log(`[${agentId}] ${msg}`, lvl),
    signal: params.signal ?? params.parentContext.signal,
  }

  const promptMessage = createUserMessage(params.prompt)

  return runQueryLoop({
    systemPrompt: params.parentSystemPrompt,         // 复用 prompt cache
    messages: [...params.parentMessages, promptMessage],
    tools: params.tools,
    canUseTool: params.canUseTool,                   // ← 通常更严格
    context: subContext,
    maxTurns: params.maxTurns ?? 5,
    isForkedAgent: true,                             // ← 抑制 stop hook
  })
}
```

**为什么要继承 parentSystemPrompt + parentMessages？**

- 主项目里这是为了命中 Anthropic API 的**prompt caching**：同样的前缀走
  缓存，子 agent 的实际计费只到末尾的新 prompt 部分。
- 让子 agent 拿到完整对话上下文，否则它没法准确总结刚才发生了什么。

`hasMemoryWritesSince` 是配套工具，用来在 fork 之前判断"主 agent 是不是
已经亲自写过记忆了"——如果写过，就不要再 fork 一个抽取器去重写：

```typescript
export function hasMemoryWritesSince(
  messages: Message[], sinceUuid: string | undefined, memoryDir: string,
): boolean {
  const memRoot = resolve(memoryDir) + '/'
  const start = findIndexAfterUuid(messages, sinceUuid)
  for (let i = start; i < messages.length; i++) {
    for (const path of extractWrittenPaths(messages[i])) {
      if ((path + '/').startsWith(memRoot)) return true
    }
  }
  return false
}
```

对应主项目：`src/services/extractMemories/runForkedAgent.ts` +
`hasMemoryWritesSince`。

---

### 3.6 `extractMemories.ts` — Stop Hook 与并发控制

这是整个 demo 最"工程化"的一块代码，因为后台任务必须正确处理：

| 问题 | 解决方案 |
|---|---|
| 用户连发 5 条消息，触发 5 次抽取 → 浪费 token | **节流**：上次抽取后 ≥ 60s 才允许下一次 |
| 抽取还没跑完，用户又发了一条 → 重复抽取 | **单飞**：`inProgress` 标志 + `pendingTrailingRun` 队列 |
| 用户在 chat 里直接保存了一条记忆 → 后台不该再抽 | **互斥**：`hasMemoryWritesSince(parentMessages, lastMemoryMessageUuid, memoryDir)` |
| 进程要退出 → 后台还在跑 | **drain**：`agent.drain(timeoutMs)` 等待 in-flight |

闭包封装的状态：

```typescript
export function initExtractMemories(cfg = {}): ExtractMemoriesController {
  let inProgress = false
  let pendingTrailingRun = false
  let lastRunAt = 0
  let lastMemoryMessageUuid: string | undefined  // 上次抽取观察到的最后一条消息
  const inFlight: Set<Promise<void>> = new Set()
  // …
}
```

执行函数：

```typescript
async function runExtraction(messages: Message[], ctx: ToolUseContext, isTrailing: boolean) {
  // 互斥：用户已亲自保存 → skip
  if (hasMemoryWritesSince(messages, lastMemoryMessageUuid, memoryDir)) {
    advanceCursor(messages)
    return
  }

  // 节流
  const now = Date.now()
  if (!isTrailing && now - lastRunAt < cfg.minIntervalMs) return

  const result = await runForkedAgent({
    parentSystemPrompt: 'You are an autonomous subagent…',
    parentMessages: messages,
    tools: ALL_TOOLS,
    canUseTool: restrictToMemoryDirPermission(memoryDir),  // ← 关键
    parentContext: ctx,
    prompt: buildExtractMemoriesPrompt(memoryDir),
    maxTurns: cfg.maxTurns,
    forkLabel: 'extract_memories',
  })

  lastRunAt = now
  advanceCursor(result.messages)

  // 通知 onMemoriesSaved 回调
  const writtenPaths = result.messages.flatMap(extractWrittenPaths)
    .filter(p => p.startsWith(memoryDir))
  if (writtenPaths.length) cfg.onMemoriesSaved?.(writtenPaths)
}
```

对外的 `run` 是单飞包装：

```typescript
async function run(messages, ctx) {
  if (inProgress) {
    pendingTrailingRun = true   // 排队一个 trailing run
    return
  }
  inProgress = true
  const promise = runExtraction(messages, ctx, false)
    .finally(() => {
      inProgress = false
      if (pendingTrailingRun) {
        pendingTrailingRun = false
        run(messages, ctx)        // 收尾
      }
    })
  inFlight.add(promise)
  promise.finally(() => inFlight.delete(promise))
}

async function drain(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.race([Promise.all([...inFlight]), sleep(500)])
  }
}
```

对应主项目：`src/services/extractMemories/extractMemories.ts`，几乎一对一
（仅省略了 telemetry / cost tracking）。

---

### 3.7 `llm.ts` — Moonshot/Kimi 工具调用客户端

Moonshot（月之暗面）的 API 是 OpenAI 完全兼容的，所以这块代码同样适用于
任何 OpenAI 风格的端点：DeepSeek、Together、Groq、本地 vLLM……

关键是**类型转换**：

1. **工具定义**：内部 `Tool[]` → OpenAI tools array

   ```typescript
   const openAITools = tools.map(t => ({
     type: 'function',
     function: {
       name: t.name,
       description: t.description,
       parameters: zodToJsonSchema(t.inputSchema),   // 极简实现，handle 常见 zod 类型
     },
   }))
   ```

2. **历史消息**：内部 `Message[]` → OpenAI messages

   - `text` block → `content: string`
   - `tool_use` block → `tool_calls: [{ id, type: 'function', function: {...} }]`
   - `tool_result` block → 单独的 `role: 'tool'` 消息 (one per tool_use_id)

3. **响应**：OpenAI `choices[0].message` → 内部 `AssistantMessage`

   ```typescript
   const content: ContentBlock[] = []
   if (msg.content) content.push({ type: 'text', text: msg.content })
   for (const tc of msg.tool_calls ?? []) {
     content.push({
       type: 'tool_use',
       id: tc.id,
       name: tc.function.name,
       input: JSON.parse(tc.function.arguments),
     })
   }
   return { uuid, role: 'assistant', content, stop_reason: msg.tool_calls ? 'tool_use' : 'end_turn' }
   ```

`isLLMAvailable()` / `loadLLMConfig()` 给 `--scripted` 模式留了 escape
hatch：没有 key 时不调网络，错误信息直接告诉用户怎么修。

对应主项目：`src/services/claude.ts` + `src/services/anthropic.ts`，但更
简单（少了 streaming / cost tracking / retry）。

---

### 3.8 `systemPrompt.ts` — 把 Memory Prompt 注入主 Prompt

```typescript
import { buildMemoryPrompt } from './memory/index.js'

export async function buildSystemPrompt(params): Promise<string> {
  const memorySection = await buildMemoryPrompt(params.memoryDir)  // ← 复用记忆系统
  const toolList = params.tools.map(t => `- \`${t.name}\` — ${t.description}`).join('\n')

  return [
    `# ${agentName} — agent tool-call demo`,
    'You are a small but conscientious autonomous coding assistant…',
    '## Available tools', '', toolList,
    '## Behavior',
    '- Always call `search_memory` BEFORE answering questions about the user…',
    '---',
    memorySection,    // 完整的 memory 指令 + MEMORY.md 索引
  ].join('\n')
}
```

`Agent` 类调用一次 `buildSystemPrompt` 后就缓存住，但 `/reload` 命令可以
强制刷新（在 REPL 里改了 `MEMORY.md` 之后用得着）。

对应主项目：`src/constants/prompts.ts` + `src/services/extractMemories/prompts.ts`。

---

### 3.9 `agent.ts` — 高层 Agent 类

把上面所有零件粘起来：

```typescript
export class Agent {
  private history: Message[] = []
  private systemPrompt: string | null = null
  private extractor: ExtractMemoriesController

  constructor(opts: AgentOptions) {
    this.extractor = initExtractMemories({
      memoryDir: opts.memoryDir,
      onMemoriesSaved: opts.onMemoriesSaved,
      minIntervalMs: opts.extractorMinIntervalMs,
      maxTurns: opts.extractorMaxTurns,
    })
  }

  async chat(userInput: string): Promise<string> {
    if (!this.systemPrompt) await this.refreshSystemPrompt()

    this.history.push(createUserMessage(userInput))

    const stopHook: StopHookFn = async ({ messages, context }) => {
      // fire-and-forget — 不阻塞用户看到回复
      void this.extractor.run(messages, context)
    }

    const result = await runQueryLoop({
      systemPrompt: this.systemPrompt!,
      messages: this.history,
      tools: this.tools,
      canUseTool: allowAllPermission,
      context: this.makeContext(),
      maxTurns: this.opts.maxTurns ?? 10,
      stopHooks: [stopHook],
    })

    // 用 returned messages 替换 history（包含本轮所有 tool_use/tool_result）
    this.history = result.messages
    return getText(result.finalMessage)
  }

  async drain(timeoutMs?: number) { await this.extractor.drain(timeoutMs) }
  async refreshSystemPrompt() {
    this.systemPrompt = await buildSystemPrompt({
      memoryDir: this.opts.memoryDir, tools: this.tools, agentName: 'Codey',
    })
  }
}
```

对应主项目：`src/coordinator/Coordinator.tsx` 等高层编排（但主项目还要
处理 UI / streaming / 多模态 / sub-task）。

---

### 3.10 `scripted.ts` — 可重复的离线演示

这是教学价值最高的一块代码。`CannedModel` 替换 `callLLM`，按预定义脚本
返回响应；其它部分（query loop / 权限 / 工具）全是真的：

```typescript
class CannedModel {
  constructor(private script: AssistantMessage[]) {}
  private idx = 0
  async respond(): Promise<AssistantMessage> {
    if (this.idx >= this.script.length) throw new Error('script exhausted')
    return this.script[this.idx++]
  }
}
```

3 个场景：

1. **Scenario 1**: 主 agent 按脚本调 `search_memory`，第二轮收到结果后给
   出最终文本，stop hook 触发 extractor（extractor 那部分会因为 scripted
   模式没有 LLM 而优雅失败——这恰好演示了"后台失败不影响主流程"）。

2. **Scenario 2**: 直接 `runForkedAgent` 一个 extractor，按脚本要求它写
   两个文件：`memoryDir/project_demo_run.md` (✅ allow) 和
   `cwd/pwned.txt` (❌ deny)。日志清楚地标出 deny。

3. **Scenario 3**: 不打 mock，直接调 `runQueryLoop`——`callLLM` 会因为
   缺 KIMI_API_KEY 抛错，验证错误路径。

跑一遍：`npm run demo`，肉眼能看到 4 类关键日志：

```
INFO  [main] turn 1: assistant emitted 2 block(s) (stop=tool_use)
INFO  [main]   ↳ EXEC search_memory → ok (561 chars)
WARN  [scripted_extractor] [permission] denied write_file write to … (outside …)
WARN  [scripted_extractor] [extractor]   ↳ DENY write_file: …
```

---

### 3.11 `cli.ts` — 入口

`--scripted` → `runScripted(memoryDir)`（不读 KIMI_API_KEY）。

`--repl`（默认）→ readline 循环 + `Agent.chat`，退出前 `await
agent.drain(10_000)` 给后台一点时间收尾。

`memoryDir` 优先级：`MEMORY_DIR` env > `./memory`（默认使用本包内置示例存储）。

---

## 四、与主项目的对应关系总览

| 本 demo | 主项目 |
|---|---|
| `src/types.ts` | `src/Tool.ts`, `src/types/agent.ts` |
| `src/tools/*.ts` | `src/tools/*Tool/` |
| `src/permissions.ts` | `src/permissions.ts` + canUseTool 工厂 |
| `src/llm.ts` | `src/services/anthropic.ts` (简化 + 改 OpenAI 风格) |
| `src/query.ts` | `src/query.ts` 的 `query()` async generator |
| `src/forkedAgent.ts` | `src/services/extractMemories/runForkedAgent.ts` |
| `src/extractMemories.ts` | `src/services/extractMemories/extractMemories.ts` |
| `src/agent.ts` | `src/coordinator/Coordinator.tsx`（粗略） |
| stop hook 机制 | `src/query/stopHooks.ts` |
| `scripted.ts` | 测试夹具（`__tests__` 下的 mock helpers） |

---

## 五、扩展练习

读懂 demo 之后，下面这些改造都是"加 < 100 行"级别：

1. **加一个 `bash` 工具**，演示带 timeout / abort 的子进程封装。
2. **把 `restrictToMemoryDirPermission` 升级为白名单 + 黑名单**，参考
   `src/permissions.ts` 真实实现。
3. **加 streaming 输出**：把 `callLLM` 改用 SSE，逐 token 推到 `Agent`，
   再把 stop hook 排到流结束之后。
4. **加 telemetry**：在 `executeOne` 前后打点，记录每个工具的耗时和
   token 占用。
5. **加 AutoDream**：再写一个 stop hook，每 30 分钟跑一次"记忆整合" fork。
6. **持久化 history**：把 `Agent.history` 序列化到 `.codey/sessions/`，
   下次启动恢复。

每一项都对应主项目里的一个真实模块——把它们独立做完，等于把 Claude Code
的 Agent 内核完整复现了一遍。

# Agent Tool-Call Demo

A runnable, **Claude-Code-shaped agent** built around three ideas the parent
project leans on heaviest:

1. **Query loop** — LLM emits `tool_use` blocks, the runtime executes tools in
   parallel, results come back as `tool_result`, repeat until the model stops.
2. **Forked sub-agents with their own permission policy** — background work
   (memory extraction in this demo) runs in an isolated context that inherits
   the parent's prompt cache but is sandboxed via `CanUseToolFn`.
3. **Stop hooks** — when the main loop finishes a turn, fire-and-forget side
   effects (extracting memories, autosave, telemetry) run *after* the user has
   already seen the answer.

It plugs into the sibling [`memory-system`](../memory-system/README.md) demo
and re-uses its `findRelevantMemories`, `buildMemoryPrompt`, `saveMemory` etc.
so the persistent-memory loop is **end-to-end real**, not faked.

> **One-liner:** "What does Claude Code's `query` loop look like, distilled into
> ~1.2 kloc of TypeScript that you can step through in an afternoon?"

---

## What it demonstrates

| Concept (parent project) | Where it lives here |
|---|---|
| `Tool` interface (`name` / `description` / `inputSchema` / `isReadOnly` / `call`) | `src/types.ts`, `src/tools/*.ts` |
| Permission gating (`CanUseToolFn`, allow / deny / updatedInput) | `src/permissions.ts` |
| Query loop (`tool_use` ↔ `tool_result` until `end_turn`) | `src/query.ts` |
| Forked agents inheriting the parent context | `src/forkedAgent.ts` |
| Stop hooks (background work *after* the model is done) | `src/agent.ts`, `src/extractMemories.ts` |
| Mutual exclusion between main writes and background extractor | `src/extractMemories.ts` (`hasMemoryWritesSince`) |
| Throttling / single-flighting / trailing-run behaviour | `src/extractMemories.ts` |
| OpenAI-compatible tool-calling (Moonshot/Kimi) | `src/llm.ts` |
| Memory-aware system prompt | `src/systemPrompt.ts` (calls `buildMemoryPrompt`) |
| Offline, deterministic walkthrough (no LLM key needed) | `src/scripted.ts` |

---

## Quick start

```bash
cd packages/agent-tool-call
npm install

# Offline scripted demo — no API key, three end-to-end scenarios
npm run demo

# Interactive REPL — needs KIMI_API_KEY in .env
cp .env.example .env
# edit .env and add your Moonshot key
npm run repl
```

The demo defaults to the sibling memory directory at
`../memory-system/memory`, so any memory the agent saves shows up immediately
in the memory-system demo too. Override with `MEMORY_DIR=...` or pass
`--memory-dir <path>` (REPL flag).

### REPL commands

| Command | Effect |
|---|---|
| `/quit` or `/exit` | Drain background work, then exit |
| `/history` | Print message-count of in-process conversation |
| `/reload` | Rebuild the system prompt from the latest `MEMORY.md` |
| `/memory` | Print the active memory directory |

---

## Scripted demo (the interesting bit)

`npm run demo` runs three offline scenarios using a tiny `CannedModel`
(no API needed). It exercises the *real* query loop, the *real* permission
checker, and the *real* extractor entry-point — only the LLM is canned.

```text
▶ Scenario 1: main agent searches memory, answers, then extractor fires
  - turn 1: assistant emits search_memory tool_use
  - search_memory hits the memory-system demo's findRelevantMemories
  - turn 2: assistant produces final text
  - stop hook → fire-and-forget runForkedAgent('extract_memories')

▶ Scenario 2: forked extractor tries to write outside memoryDir → DENY
  - write inside memoryDir  → ALLOW
  - write to ../../pwned.txt → DENY (permission policy refuses, returns
    deny block to the model so it can recover)

▶ Scenario 3: runQueryLoop without an API key — graceful error path
  - LLM call surfaces a precise, actionable error message
```

---

## Why does this look like Claude Code?

The shape of `runQueryLoop` is identical to `src/query.ts` in the parent
project, just collapsed:

```ts
while (turn++ < maxTurns) {
  const assistant = await callLLM({ systemPrompt, history, tools })
  history.push(assistant)

  const toolUses = getToolUses(assistant)
  if (toolUses.length === 0) break        // model is done

  const results = await Promise.all(
    toolUses.map(tu => executeOne(tu, tools, canUseTool, ctx))
  )
  history.push(createUserMessage(results))
}

if (!isForkedAgent) for (const hook of stopHooks) await hook(...)
return { messages: history, finalMessage: history.at(-1)! }
```

Permission checks happen *before* `tool.call`:

```ts
const decision = await canUseTool(tool, parsedInput, ctx)
if (decision.behavior === 'deny') {
  return { isError: true, content: `Permission denied: ${decision.message}` }
}
return tool.call(decision.updatedInput, ctx)
```

The extractor is *exactly* a sub-agent invocation — same loop, same tools,
different prompt and a stricter `canUseTool` (writes restricted to
`memoryDir`):

```ts
runForkedAgent({
  parentSystemPrompt,
  parentMessages: messages,    // share the prompt cache
  prompt: extractMemoriesPrompt,
  tools: ALL_TOOLS,
  canUseTool: restrictToMemoryDirPermission(memoryDir),
  forkLabel: 'extract_memories',
})
```

---

## Project layout

```
agent-tool-call/
├── src/
│   ├── types.ts           # Message / ContentBlock / Tool / ToolUseContext
│   ├── tools/
│   │   ├── readFile.ts    # read_file       (read-only)
│   │   ├── writeFile.ts   # write_file      (write — gated)
│   │   ├── listDir.ts     # list_dir        (read-only)
│   │   ├── searchMemory.ts# search_memory   (proxies findRelevantMemories)
│   │   └── index.ts       # ALL_TOOLS, findToolByName
│   ├── permissions.ts     # allowAllPermission, restrictToMemoryDirPermission
│   ├── llm.ts             # Moonshot/Kimi tool-calling client + JSON-schema
│   ├── query.ts           # runQueryLoop (the heart of the demo)
│   ├── forkedAgent.ts     # runForkedAgent + hasMemoryWritesSince
│   ├── extractMemories.ts # initExtractMemories: throttle + mutex + drain
│   ├── systemPrompt.ts    # buildSystemPrompt (injects buildMemoryPrompt)
│   ├── agent.ts           # high-level Agent class with stop-hook wiring
│   ├── scripted.ts        # offline 3-scenario demo via CannedModel
│   └── cli.ts             # CLI: --scripted | --repl
├── package.json
├── tsconfig.json
└── .env.example
```
This package depends on `@quick-coding-agent/memory-system` via workspace linking.

---

## Configuration

Everything is driven by env vars (see `.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `KIMI_API_KEY` | (none) | Required for `npm run repl` |
| `KIMI_MODEL` | `moonshot-v1-8k` | Tool-calling capable |
| `KIMI_BASE_URL` | `https://api.moonshot.cn/v1` | OpenAI-compatible |
| `KIMI_TIMEOUT_MS` | `30000` | Per LLM call |
| `MEMORY_DIR` | `../memory-system/memory` | Persistent memory root |
| `DEBUG` | (unset) | `1` to dump LLM payloads + tool denials |

---

## Programmatic API (if you want to embed it)

```typescript
import { Agent } from './src/agent.js'

const agent = new Agent({
  cwd: process.cwd(),
  memoryDir: '/abs/path/to/memory',
  onMemoriesSaved: paths => console.log('extractor wrote:', paths),
})

const reply = await agent.chat('Who am I and what role do I prefer?')
console.log(reply)

await agent.drain(10_000)   // wait for background extraction before exit
```

To run a one-off forked agent yourself:

```typescript
import { runForkedAgent } from './src/forkedAgent.js'
import { ALL_TOOLS } from './src/tools/index.js'
import { restrictToMemoryDirPermission } from './src/permissions.js'

await runForkedAgent({
  parentSystemPrompt: '…',
  parentMessages: parentHistory,
  tools: ALL_TOOLS,
  canUseTool: restrictToMemoryDirPermission(memoryDir),
  parentContext: ctx,
  prompt: 'Summarise the last conversation into a single project_*.md memory.',
  maxTurns: 5,
  forkLabel: 'manual_extract',
})
```

---

## Limitations (intentional)

This is a teaching demo, not a replacement for the real agent runtime.
Things that are deliberately omitted:

- **Streaming responses** — we wait for the full LLM completion per turn.
- **Cost / token tracking** — only basic per-turn logging.
- **MCP servers, sub-skills, plug-ins, hooks file** — would dwarf the demo.
- **Compaction / context-window management** — short conversations only.
- **AutoDream consolidation** — see `src/services/autoDream/` in the parent
  project; it's the same forked-agent pattern with a different prompt.
- **Persistent on-disk message log** — history lives in process memory only.

---

## See also

- [`packages/memory-system`](../memory-system/README.md) — the persistent-memory
  half of the architecture, used as a library here.
- `src/query.ts` (parent project) — the production query loop this demo
  mirrors.
- `src/services/extractMemories/` (parent project) — the production
  extractor this demo's `extractMemories.ts` is a faithful miniature of.
- `IMPLEMENTATION.md` — detailed walkthrough of every module.

# Memory System Demo

This is a runnable demonstration of the core **Claude Code memory system** — a file-based persistent memory architecture with **Kimi (Moonshot AI) LLM integration** for semantic relevance retrieval.

## What It Demonstrates

| Feature | Description |
|---------|-------------|
| **4 Memory Types** | `user`, `feedback`, `project`, `reference` with frontmatter validation |
| **MEMORY.md Index** | Concise index file with auto-truncation (200 lines / 25KB caps) |
| **Directory Scanning** | Scans `.md` files, parses frontmatter, sorts newest-first |
| **LLM Semantic Retrieval** | Calls Kimi API to select memories by semantic meaning |
| **Local Fallback** | Keyword-based scoring when LLM is unavailable |
| **Staleness Detection** | Memories >1 day old get a freshness warning |
| **Behavioral Prompt** | Builds the full system-prompt text injected into Claude Code |
| **Save / Update / Delete** | Memory CRUD with automatic index synchronization |

## Quick Start

```bash
cd packages/memory-system
npm install

# Run with local keyword scoring (no API key needed)
npm run demo:local

# Run with Kimi LLM semantic retrieval (requires API key)
cp .env.example .env
# Edit .env and add your KIMI_API_KEY
npm run demo
```

## Kimi API Configuration

The memory system supports **semantic relevance selection** via the Kimi (Moonshot AI) API. This allows the system to understand the _meaning_ of queries, not just keyword matches.

### Setup

1. Get an API key from [platform.moonshot.cn](https://platform.moonshot.cn/)
2. Create a `.env` file:

```bash
cp .env.example .env
```

3. Edit `.env`:

```
KIMI_API_KEY=sk-your-key-here
# Optional:
# KIMI_MODEL=moonshot-v1-8k        # default
# KIMI_BASE_URL=https://api.moonshot.cn/v1
# KIMI_TIMEOUT_MS=10000
```

### Graceful Degradation

When Kimi API is unavailable (no key, network error, timeout), the system **automatically falls back** to local keyword-based scoring. You don't need to configure anything for the demo to work.

| Scenario | Behavior |
|----------|----------|
| API key missing | Fallback to local keyword scoring |
| Network timeout (10s) | Fallback to local keyword scoring |
| API returns error | Fallback to local keyword scoring |
| JSON parse failure | Fallback to local keyword scoring |
| `--no-llm` flag | Force local keyword scoring |

## Two Retrieval Modes

### 1. LLM Semantic Selection (Default)

Uses Kimi API to understand query intent and select the most semantically relevant memories.

**Advantages:**
- Understands synonyms and paraphrases (e.g., "verify changes" → `feedback_testing.md`)
- Can match on meaning even when keywords don't overlap
- Respects "recently used tools" filter to avoid reference noise

**Example:**
```
Query: "How do I verify my changes are safe?"
LLM selects: feedback_testing.md  ("integration tests must hit real database")
```

### 2. Local Keyword Scoring (Fallback)

Uses weighted keyword matching when LLM is unavailable.

**Scoring weights:**
| Match Location | Weight |
|----------------|--------|
| Filename | +3 |
| Description | +2 |
| Full content | +1 |

**Limitations:**
- Requires keyword overlap between query and memory
- Cannot understand synonyms or semantic relationships

## Project Structure

```
memory-system/
├── src/
│   ├── types.ts       # MemoryType enum, MemoryHeader, FrontmatterData
│   ├── parser.ts      # Frontmatter parser + memory file builder
│   ├── scanner.ts     # Directory scan → sorted MemoryHeader[]
│   ├── indexer.ts     # MEMORY.md read / write / truncate
│   ├── store.ts       # saveMemory, updateMemoryContent, deleteMemory
│   ├── retriever.ts   # findRelevantMemories (LLM + local fallback)
│   ├── prompts.ts     # buildMemoryPrompt (system prompt text)
│   ├── age.ts         # memoryAgeDays, memoryFreshnessText/Note
│   ├── config.ts      # Environment config (KIMI_API_KEY, etc.)
│   ├── llm.ts         # Kimi API client for semantic selection
│   ├── cli.ts         # Interactive demo runner
│   └── index.ts       # Public API exports
├── memory/            # Sample memory storage directory
│   ├── MEMORY.md
│   ├── user_role.md
│   ├── feedback_testing.md
│   ├── project_release.md
│   └── reference_dashboards.md
├── package.json
├── tsconfig.json
└── .env.example
```

## Programmatic API

```typescript
import {
  buildMemoryPrompt,
  scanMemoryFiles,
  findRelevantMemories,
  saveMemory,
  memoryFreshnessNote,
  loadConfig,
} from './src/index.js'

// Build the system prompt text
const prompt = await buildMemoryPrompt('./memory')

// Scan all memory files
const memories = await scanMemoryFiles('./memory')

// Find memories relevant to a query (auto-detects LLM availability)
const result = await findRelevantMemories('testing policy', './memory')
console.log(result.usedLLM)   // true if Kimi API was used
console.log(result.model)     // e.g., "moonshot-v1-8k"
console.log(result.memories)  // Array of RelevantMemory

// Force local keyword scoring
const localResult = await findRelevantMemories('testing policy', './memory', {
  useLLM: false,
})

// Save a new memory (auto-indexes in MEMORY.md)
await saveMemory({
  memoryDir: './memory',
  filename: 'project_api_migration.md',
  name: 'API v2 migration plan',
  description: 'Migration from REST v1 to GraphQL v2',
  type: 'project',
  content: '...',
})
```

## How LLM Retrieval Works

```
User Query
    │
    ▼
scanMemoryFiles() → MemoryHeader[]
    │
    ▼
callKimiSelectMemories()
    ├── System prompt: "Select relevant memories..."
    ├── User message: Query + memory manifest
    ├── POST https://api.moonshot.cn/v1/chat/completions
    └── Parse JSON response: { selected_memories: [...] }
    │
    ▼
Map filenames → MemoryHeader → readFile() → RelevantMemory[]
    │
    ▼
Return with metadata: { memories, usedLLM: true, model }
```

If any step fails (no API key, network error, parse error), the system immediately falls back to local keyword scoring.

## CLI Arguments

| Flag | Description |
|------|-------------|
| `--demo` | Run the full interactive demo |
| `--no-llm` | Force local keyword scoring (skip Kimi API) |

```bash
npm run demo              # Full demo with LLM if configured
npm run demo:local        # Force local scoring
node dist/cli.js          # Print system prompt only
```

/**
 * CLI demo for the memory system.
 *
 * Run with: npm run demo
 *
 * Demonstrates:
 *   1. Building the memory behavioral prompt
 *   2. Scanning memory directory
 *   3. Finding relevant memories (LLM + fallback)
 *   4. Saving a new memory
 *   5. Showing memory freshness / staleness
 */

import 'dotenv/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  ensureMemoryDirExists,
  saveMemory,
  deleteMemory,
} from './store.js'
import { scanMemoryFiles, formatMemoryManifest } from './scanner.js'
import { readEntrypoint } from './indexer.js'
import { findRelevantMemories, formatRelevantMemories } from './retriever.js'
import { buildMemoryPrompt } from './prompts.js'
import { memoryAge, memoryFreshnessNote } from './age.js'
import { loadConfig, isKimiAvailable } from './config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MEMORY_DIR = resolve(__dirname, '../memory')

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
}

function c(name: keyof typeof COLORS, text: string): string {
  return `${COLORS[name]}${text}${COLORS.reset}`
}

function hr(): void {
  console.log(c('dim', '─'.repeat(60)))
}

function heading(text: string): void {
  hr()
  console.log(c('bold', `  ${text}`))
  hr()
  console.log()
}

async function demoBuildPrompt(): Promise<void> {
  heading('1. BUILD MEMORY BEHAVIORAL PROMPT')
  console.log(
    c(
      'dim',
      'This is the text injected into the system prompt in Claude Code.\n',
    ),
  )

  const prompt = await buildMemoryPrompt(MEMORY_DIR)
  console.log(prompt.slice(0, 1500))
  console.log(c('dim', '\n  ... (truncated for display) ...'))
  console.log(
    c(
      'dim',
      `\n  Total prompt length: ${prompt.length} chars`,
    ),
  )
}

async function demoScan(): Promise<void> {
  heading('2. SCAN MEMORY DIRECTORY')
  console.log(
    c('dim', `Scanning: ${MEMORY_DIR}\n`),
  )

  const memories = await scanMemoryFiles(MEMORY_DIR)

  if (memories.length === 0) {
    console.log(c('yellow', '  No memory files found.'))
    return
  }

  console.log(c('green', `  Found ${memories.length} memory file(s):\n`))
  console.log(formatMemoryManifest(memories))
}

async function demoEntrypoint(): Promise<void> {
  heading('3. MEMORY.md INDEX (with truncation check)')

  const raw = await readEntrypoint(MEMORY_DIR)
  if (!raw) {
    console.log(c('yellow', '  MEMORY.md is empty or does not exist.'))
    return
  }

  console.log(c('dim', 'Raw entrypoint content:\n'))
  console.log(raw)
}

async function demoRetrieve(useLLM: boolean): Promise<void> {
  heading('4. FIND RELEVANT MEMORIES')

  const config = loadConfig()
  const llmStatus = isKimiAvailable(config)
    ? c('green', 'Kimi API available')
    : c('yellow', 'Kimi API unavailable — will use local fallback')

  console.log(c('dim', `LLM status: ${llmStatus}`))
  console.log(c('dim', `Mode: ${useLLM ? 'LLM semantic selection' : 'Local keyword scoring'}\n`))

  const queries = [
    'How should I handle testing in this project?',
    'What dashboards should I monitor?',
    'Tell me about the user preferences',
    'How do I verify my changes are safe?', // semantic test — no keyword overlap
  ]

  for (const query of queries) {
    console.log(c('cyan', `  Query: "${query}"`))
    const result = await findRelevantMemories(query, MEMORY_DIR, {
      useLLM,
      config,
    })

    const engineLabel = result.usedLLM
      ? c('blue', `[LLM:${result.model}]`)
      : c('yellow', '[local]')

    if (result.memories.length === 0) {
      console.log(c('yellow', `  → ${engineLabel} No relevant memories found.\n`))
      continue
    }

    console.log(
      c('green', `  → ${engineLabel} ${result.memories.length} relevant memory(s):`),
    )
    for (const m of result.memories) {
      const freshness = memoryFreshnessNote(m.mtimeMs)
      const age = memoryAge(m.mtimeMs)
      console.log(
        `    - ${c('bold', m.filename)} (${age})`,
      )
      if (freshness) {
        console.log(
          `      ${c('yellow', '[STALE]')} ${freshness.trim()}`,
        )
      }
    }
    console.log()
  }
}

async function demoCompareEngines(): Promise<void> {
  heading('4b. LLM vs LOCAL COMPARISON')

  const config = loadConfig()
  if (!isKimiAvailable(config)) {
    console.log(
      c('yellow', '  Skipping comparison — Kimi API key not configured.\n'),
    )
    console.log(
      c('dim', '  Set KIMI_API_KEY in your environment to enable LLM retrieval.'),
    )
    return
  }

  const query = 'How do I verify my changes are safe?'
  console.log(c('cyan', `  Query: "${query}"\n`))

  // LLM result
  const llmResult = await findRelevantMemories(query, MEMORY_DIR, {
    useLLM: true,
    config,
  })
  console.log(
    c('blue', `  LLM (${llmResult.model}):`),
  )
  if (llmResult.memories.length === 0) {
    console.log(c('yellow', '    No memories selected'))
  } else {
    for (const m of llmResult.memories) {
      console.log(`    - ${m.filename}`)
    }
  }

  // Local result
  const localResult = await findRelevantMemories(query, MEMORY_DIR, {
    useLLM: false,
    config,
  })
  console.log(
    c('yellow', '  Local keyword:'),
  )
  if (localResult.memories.length === 0) {
    console.log(c('yellow', '    No memories matched'))
  } else {
    for (const m of localResult.memories) {
      console.log(`    - ${m.filename}`)
    }
  }

  console.log()
  console.log(
    c(
      'dim',
      '  Note: LLM can match on semantic meaning even when keywords differ.',
    ),
  )
}

async function demoSave(): Promise<void> {
  heading('5. SAVE A NEW MEMORY')

  const filename = 'project_api_migration.md'
  console.log(
    c('dim', `Saving memory to: ${filename}\n`),
  )

  await saveMemory({
    memoryDir: MEMORY_DIR,
    filename,
    name: 'API v2 migration plan',
    description: 'Migration from REST v1 to GraphQL v2 scheduled for Q3',
    type: 'project',
    content:
      'The backend team is migrating from REST v1 to GraphQL v2.\n\n' +
      '**Why:** v1 endpoints have become unmaintainable with 200+ custom endpoints.\n' +
      '**How to apply:** All new features should target the `/graphql` endpoint. Legacy REST endpoints are in maintenance mode only.',
    hook: 'Backend migration from REST v1 to GraphQL v2',
  })

  console.log(c('green', '  ✓ Memory saved and indexed.'))

  // Show updated scan
  console.log(c('dim', '\n  Updated memory manifest:\n'))
  const memories = await scanMemoryFiles(MEMORY_DIR)
  console.log(formatMemoryManifest(memories.slice(0, 5)))
}

async function demoFreshness(): Promise<void> {
  heading('6. MEMORY FRESHNESS / STALENESS')

  const memories = await scanMemoryFiles(MEMORY_DIR)
  if (memories.length === 0) return

  console.log(
    c('dim', 'Age and staleness for each memory:\n'),
  )

  for (const m of memories) {
    const age = memoryAge(m.mtimeMs)
    const stale = memoryFreshnessNote(m.mtimeMs)
    const icon = stale ? c('red', '⚠') : c('green', '✓')
    const ageStr = c(stale ? 'yellow' : 'green', age)
    console.log(`  ${icon} ${c('bold', m.filename)} — ${ageStr}`)
    if (stale) {
      console.log(
        `     ${c('dim', stale.trim())}`,
      )
    }
  }
}

async function demoFullContent(useLLM: boolean): Promise<void> {
  heading('7. FULL CONTENT OF A RELEVANT MEMORY')

  const config = loadConfig()
  const query = 'testing policy'
  const result = await findRelevantMemories(query, MEMORY_DIR, {
    useLLM,
    config,
  })

  if (result.memories.length === 0) {
    console.log(c('yellow', '  No relevant memories for this query.'))
    return
  }

  const m = result.memories[0]
  const engineLabel = result.usedLLM
    ? c('blue', `[LLM:${result.model}]`)
    : c('yellow', '[local]')

  console.log(
    c('cyan', `Query: "${query}" → ${m.filename} ${engineLabel}\n`),
  )
  console.log(formatRelevantMemories([m]))
}

async function cleanupDemoMemory(): Promise<void> {
  try {
    await deleteMemory(MEMORY_DIR, 'project_api_migration.md')
  } catch {
    // ignore if already cleaned up
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const isDemo = args.includes('--demo')
  const noLLM = args.includes('--no-llm')
  const useLLM = !noLLM

  const config = loadConfig()

  console.log(
    c(
      'magenta',
      '\n╔══════════════════════════════════════════════════════════╗',
    ),
  )
  console.log(
    c(
      'magenta',
      '║        Claude Code Memory System — Core Demo             ║',
    ),
  )
  console.log(
    c(
      'magenta',
      '╚══════════════════════════════════════════════════════════╝',
    ),
  )
  console.log()

  // Show config status
  if (isKimiAvailable(config)) {
    console.log(
      c('green', `✓ Kimi API configured (model: ${config.kimiModel})`),
    )
  } else {
    console.log(
      c('yellow', '⚠ Kimi API not configured — using local keyword fallback'),
    )
    console.log(
      c('dim', '  Set KIMI_API_KEY to enable semantic memory retrieval.'),
    )
  }
  if (noLLM) {
    console.log(c('yellow', '  --no-llm flag set: forcing local keyword scoring'))
  }
  console.log()

  await ensureMemoryDirExists(MEMORY_DIR)

  if (isDemo) {
    // Clean up any leftover from previous runs
    await cleanupDemoMemory()

    await demoBuildPrompt()
    await demoScan()
    await demoEntrypoint()
    await demoRetrieve(useLLM)
    await demoCompareEngines()
    await demoSave()
    await demoFreshness()
    await demoFullContent(useLLM)

    heading('DEMO COMPLETE')
    console.log(
      c(
        'green',
        'All core memory system features demonstrated successfully.\n',
      ),
    )

    // Interactive mode: let user query memories
    console.log(c('bold', 'Interactive query mode (type "exit" to quit):\n'))

    const stdin = process.stdin
    stdin.setEncoding('utf-8')
    stdin.resume()

    process.stdout.write(c('cyan', 'query> '))

    stdin.on('data', async (data: Buffer) => {
      const query = data.toString().trim()
      if (query === 'exit') {
        console.log(c('dim', '\nGoodbye!'))
        process.exit(0)
      }

      const result = await findRelevantMemories(query, MEMORY_DIR, {
        useLLM,
        config,
      })

      const engineLabel = result.usedLLM
        ? c('blue', `[LLM:${result.model}]`)
        : c('yellow', '[local]')

      if (result.memories.length === 0) {
        console.log(c('yellow', `${engineLabel} No relevant memories found.`))
      } else {
        console.log(
          c('green', `${engineLabel} Found ${result.memories.length} relevant memory(s):\n`),
        )
        console.log(formatRelevantMemories(result.memories))
      }

      process.stdout.write(c('cyan', '\nquery> '))
    })
  } else {
    // Simple scan + prompt mode
    const prompt = await buildMemoryPrompt(MEMORY_DIR)
    console.log(prompt)
  }
}

main().catch((err) => {
  console.error(c('red', String(err)))
  process.exit(1)
})

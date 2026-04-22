/**
 * CLI entry point.
 *
 *   npm run demo            → scripted offline demo (no API key required)
 *   npm run repl            → interactive REPL via Kimi/Moonshot
 *   node dist/cli.js        → defaults to --repl
 *
 * Both modes share the same Agent / queryLoop / extractor — only the model
 * provider differs (canned vs. live).
 */

import 'dotenv/config'
import { createInterface } from 'readline'
import { resolve } from 'path'
import { Agent } from './agent.js'
import { runScripted } from './scripted.js'

function parseArgs(argv: string[]): { mode: 'scripted' | 'repl'; memoryDir: string } {
  const args = new Set(argv.slice(2))
  const mode = args.has('--scripted') ? 'scripted' : 'repl'
  // import.meta.url points at packages/agent-tool-call/dist/cli.js once compiled, so
  // we go up 2 levels to reach the sibling memory-system package and reuse its
  // memory directory by default.
  const memoryDir = resolve(
    process.env.MEMORY_DIR ?? new URL('../../memory-system/memory', import.meta.url).pathname,
  )
  return { mode, memoryDir }
}

async function main() {
  const { mode, memoryDir } = parseArgs(process.argv)

  if (mode === 'scripted') {
    await runScripted(memoryDir)
    return
  }

  // REPL mode
  if (!process.env.KIMI_API_KEY) {
    console.error('\n[!] KIMI_API_KEY is not set — cannot run --repl.')
    console.error('    Either:')
    console.error('      • cp .env.example .env  and add your key, or')
    console.error('      • npm run demo  (scripted mode, no key needed)\n')
    process.exit(1)
  }

  console.log('\n╭──────────────────────────────────────────────────────────╮')
  console.log('│  Codey REPL — Kimi-powered agent with persistent memory │')
  console.log('├──────────────────────────────────────────────────────────┤')
  console.log(`│  memoryDir : ${memoryDir.padEnd(43)}│`)
  console.log(`│  model     : ${(process.env.KIMI_MODEL ?? 'moonshot-v1-8k').padEnd(43)}│`)
  console.log('│  commands  : /quit  /history  /reload  /memory          │')
  console.log('╰──────────────────────────────────────────────────────────╯\n')

  const agent = new Agent({
    cwd: process.cwd(),
    memoryDir,
    onMemoriesSaved: paths => {
      console.log(
        `\n  ✓ Saved ${paths.length} memor${paths.length === 1 ? 'y' : 'ies'}:`,
      )
      for (const p of paths) console.log(`     • ${p}`)
      console.log('')
    },
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(res => rl.question(q, res))

  while (true) {
    const input = (await ask('› ')).trim()
    if (!input) continue
    if (input === '/quit' || input === '/exit') break
    if (input === '/history') {
      console.log(`  ${agent.historyLength()} messages in conversation history`)
      continue
    }
    if (input === '/reload') {
      await agent.refreshSystemPrompt()
      console.log('  System prompt rebuilt with latest MEMORY.md')
      continue
    }
    if (input === '/memory') {
      console.log(`  Memory directory: ${memoryDir}`)
      continue
    }

    try {
      const reply = await agent.chat(input)
      console.log(`\n${reply}\n`)
    } catch (err) {
      console.error(`\n[error] ${(err as Error).message}\n`)
    }
  }

  rl.close()
  console.log('\nDraining background memory extraction...')
  await agent.drain(10_000)
  console.log('Goodbye.')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

/** 中文说明：核心 agent 模块。 */

/**
 * CLI entry point.
 *
 *   npm run demo   → scripted offline demo (no API key required)
 *
 * Interactive REPL has moved to @quick-coding-agent/agent-cli.
 * Run it with:  pnpm agent:repl   (from the workspace root)
 */

import 'dotenv/config'
import { resolve } from 'path'
import { runScripted } from './scripted.js'

async function main() {
  const memoryDir = resolve(
    process.env.MEMORY_DIR ?? new URL('../memory', import.meta.url).pathname,
  )
  await runScripted(memoryDir)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

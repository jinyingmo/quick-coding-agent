/** 中文说明：核心 agent 模块。 */

import 'dotenv/config'
import { loadMCPSettingsFromEnv } from './mcp/config.js'
import { loadApiKeyIdentitiesFromEnv } from './auth/apiKey.js'
import { createStructuredLogger } from './observability/logger.js'
import { createApprovalRegistry } from './runtime/approvalRegistry.js'
import { createAgentRuntime } from './runtime/agentRuntime.js'
import { createSessionRegistry } from './runtime/sessionRegistry.js'
import { startRuntimeSweeper } from './runtime/sweeper.js'
import { createP0Server } from './server/app.js'

// P0 服务器 CLI 入口：创建结构化日志、会话注册表和 HTTP 服务器
async function main() {
  const logger = createStructuredLogger({ service: 'quick-coding-agent-p0' })
  const identities = loadApiKeyIdentitiesFromEnv()
  if (identities.length === 0) {
    throw new Error('P0_API_KEYS is empty. Provide at least one bearer token identity.')
  }

  const sessionRegistry = createSessionRegistry({
    ttlMs: Number.parseInt(process.env.P0_SESSION_TTL_MS ?? '1800000', 10),
    maxSessions: Number.parseInt(process.env.P0_MAX_SESSIONS ?? '1000', 10),
    maxMessagesPerSession: Number.parseInt(process.env.P0_MAX_MESSAGES ?? '200', 10),
    maxTotalCharsPerSession: Number.parseInt(process.env.P0_MAX_SESSION_CHARS ?? '1000000', 10),
  })
  const approvalRegistry = createApprovalRegistry()
  const mcpSettings = await loadMCPSettingsFromEnv()
  const allowedMcpTools = (process.env.MCP_ALLOWED_TOOLS ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

  const runtime = createAgentRuntime({
    sessionRegistry,
    approvalRegistry,
    mcpSettings,
    allowedMcpTools,
    log: logger.child({ component: 'agent-runtime' }).toToolLogger(),
  })

  const stopSweeper = startRuntimeSweeper({
    sessionRegistry,
    approvalRegistry,
    log: msg => logger.log('info', 'runtime_sweeper', { msg }),
  })

  const server = createP0Server({ runtime, identities, logger })
  const port = Number.parseInt(process.env.PORT ?? '8787', 10)
  server.listen(port, () => {
    logger.log('info', 'server_started', { port, identities: identities.length })
  })

  const shutdown = async () => {
    stopSweeper()
    server.close()
    await runtime.dispose()
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

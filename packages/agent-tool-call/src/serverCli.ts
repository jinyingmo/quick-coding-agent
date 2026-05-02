/** 中文说明：核心 agent 模块。 */

import 'dotenv/config'
import { loadMCPSettingsFromEnv } from './mcp/config.js'
import { loadApiKeyIdentitiesFromEnv } from './auth/apiKey.js'
import { createConsoleLogger, createToolLogger } from './observability/logger.js'
import { installPanicHandlers } from './observability/panic.js'
import { createApprovalRegistry } from './runtime/approvalRegistry.js'
import { createAgentRuntime } from './runtime/agentRuntime.js'
import { createSessionRegistry } from './runtime/sessionRegistry.js'
import { startRuntimeSweeper } from './runtime/sweeper.js'
import { createP0Server, isTLSConfigured, type TLSConfig } from './server/app.js'

/** 从环境变量读取 TLS 配置 */
function loadTLSConfigFromEnv(): TLSConfig | undefined {
  const cert = process.env.TLS_CERT || process.env.TLS_CERT_PATH
  const key = process.env.TLS_KEY || process.env.TLS_KEY_PATH
  if (!cert || !key) return undefined
  return {
    cert,
    key,
    ca: process.env.TLS_CA || process.env.TLS_CA_PATH,
    requestCert: process.env.TLS_REQUEST_CERT === 'true',
  }
}

// P0 服务器 CLI 入口
async function main() {
  const logger = createConsoleLogger({ service: 'quick-coding-agent-p0' })

  // 安装全局异常捕获（最先执行，确保所有未捕获错误都被记录）
  installPanicHandlers({
    logger,
    onShutdown: async () => {
      logger.info('shutdown_started')
      await runtime.dispose().catch(() => {})
    },
  })

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
    log: createToolLogger(logger.child({ component: 'agent-runtime' })),
  })

  const stopSweeper = startRuntimeSweeper({
    sessionRegistry,
    approvalRegistry,
    log: msg => logger.info('runtime_sweeper', { msg }),
  })

  const tlsConfig = loadTLSConfigFromEnv()
  const corsOrigin = process.env.CORS_ORIGIN?.trim() || undefined

  const server = await createP0Server({
    runtime,
    identities,
    logger: logger.child({ component: 'http' }),
    tls: tlsConfig,
    corsOrigin,
    requestTimeout: Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? '120000', 10),
    headersTimeout: Number.parseInt(process.env.HEADERS_TIMEOUT_MS ?? '60000', 10),
  })

  const port = Number.parseInt(process.env.PORT ?? '8787', 10)
  const protocol = isTLSConfigured(tlsConfig) ? 'https' : 'http'

  server.listen(port, () => {
    logger.info('server_started', {
      port,
      protocol,
      identities: identities.length,
      tls: isTLSConfigured(tlsConfig),
      cors: !!corsOrigin,
      streaming: true,
    })
  })

  const shutdown = async () => {
    logger.info('shutdown_signal_received')
    stopSweeper()
    server.close()
    await runtime.dispose()
    logger.info('shutdown_complete')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch(err => {
  console.error('Failed to start server:', err)
  process.exit(1)
})

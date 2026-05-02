/** 中文说明：内置记忆子系统。 */

/**
 * Configuration management for the memory system.
 *
 * Reads LLM_* environment variables for OpenAI-compatible API integration.
 * Supports .env file via dotenv (loaded in cli.ts).
 */

export interface MemoryConfig {
  /** LLM API key (from LLM_API_KEY env var) */
  llmApiKey: string | undefined
  /** LLM model name (default: moonshot-v1-8k) */
  llmModel: string
  /** LLM API base URL (default: https://api.moonshot.cn/v1) */
  llmBaseUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  llmTimeoutMs: number
  /** Default memory directory path */
  memoryDir: string
}

/**
 * 从环境变量加载记忆系统配置，支持通过 overrides 覆盖。
 *
 * Load configuration from environment variables.
 */
export function loadConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL ?? 'moonshot-v1-8k',
    llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://api.moonshot.cn/v1',
    llmTimeoutMs: parseInt(process.env.LLM_TIMEOUT_MS ?? '10000', 10),
    memoryDir: process.env.MEMORY_DIR ?? './memory',
    ...overrides,
  }
}

/**
 * 检查 LLM API 是否已配置且可用（有 API Key）。
 *
 * Check if LLM API is configured and available.
 */
export function isLLMAvailable(config: MemoryConfig): boolean {
  return !!config.llmApiKey && config.llmApiKey.length > 0
}

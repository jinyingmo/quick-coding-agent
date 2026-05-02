/**
 * Configuration management for the memory system.
 *
 * Reads environment variables for Kimi API integration.
 * Supports .env file via dotenv (loaded in cli.ts).
 */

export interface MemoryConfig {
  /** Kimi API key (from KIMI_API_KEY env var) */
  kimiApiKey: string | undefined
  /** Kimi model name (default: moonshot-v1-8k) */
  kimiModel: string
  /** Kimi API base URL (default: https://api.moonshot.cn/v1) */
  kimiBaseUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  kimiTimeoutMs: number
  /** Default memory directory path */
  memoryDir: string
}

/**
 * Load configuration from environment variables.
 */
export function loadConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    kimiApiKey: process.env.KIMI_API_KEY,
    kimiModel: process.env.KIMI_MODEL ?? 'moonshot-v1-8k',
    kimiBaseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.cn/v1',
    kimiTimeoutMs: parseInt(process.env.KIMI_TIMEOUT_MS ?? '10000', 10),
    memoryDir: process.env.MEMORY_DIR ?? './memory',
    ...overrides,
  }
}

/**
 * Check if Kimi API is configured and available.
 */
export function isKimiAvailable(config: MemoryConfig): boolean {
  return !!config.kimiApiKey && config.kimiApiKey.length > 0
}

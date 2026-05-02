/** 中文说明：P0 HTTP(S) 服务模块。 */

/**
 * In-memory fixed-window rate limiter.
 *
 * Keyed by an arbitrary string (e.g. `userId:bucket`).
 * State is per-process — sufficient for single-instance deployments.
 * For multi-instance, replace with a Redis-backed implementation.
 */

type Window = { count: number; resetAt: number }

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSecs: number }

export type RateLimiterConfig = {
  /** 窗口内最大请求数 */
  maxRequests: number
  /** 滑动窗口时长（毫秒） */
  windowMs: number
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>()
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests
    this.windowMs = config.windowMs
  }

  check(key: string): RateLimitResult {
    const now = Date.now()
    let w = this.windows.get(key)

    if (!w || now >= w.resetAt) {
      // 过期窗口直接覆盖，顺便清理单条旧数据
      w = { count: 1, resetAt: now + this.windowMs }
      this.windows.set(key, w)
      return { allowed: true }
    }

    if (w.count >= this.maxRequests) {
      return { allowed: false, retryAfterSecs: Math.ceil((w.resetAt - now) / 1000) }
    }

    w.count++
    return { allowed: true }
  }

  /** 清理已过期的窗口，防止长时间运行后内存无限增长。由调用方按需触发。 */
  gc(): void {
    const now = Date.now()
    for (const [key, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(key)
    }
  }

  get size(): number {
    return this.windows.size
  }
}

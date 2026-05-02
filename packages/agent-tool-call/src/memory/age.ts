/** 中文说明：内置记忆子系统。 */

/**
 * Memory staleness / freshness utilities.
 *
 * Memories older than 1 day get a staleness warning
 * to prevent outdated claims from being asserted as fact.
 */

const MS_PER_DAY = 86_400_000

/**
 * 自 mtime 起已过天数，向下取整，负数输入钳为 0。
 *
 * Days elapsed since mtime. Floor-rounded.
 * Negative inputs clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / MS_PER_DAY))
}

/**
 * 人类可读的年龄字符串（today / yesterday / N days ago）。
 *
 * Human-readable age string.
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/**
 * 超过 1 天的记忆纯文本过期提示。
 *
 * Plain-text staleness caveat for memories > 1 day old.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * 单条记忆过期提示，包裹在 <system-reminder> 标签内。
 *
 * Per-memory staleness note wrapped in <system-reminder> tags.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) return ''
  return `<system-reminder>${text}</system-reminder>\n`
}

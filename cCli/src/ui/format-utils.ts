// src/ui/format-utils.ts

/**
 * 将毫秒数格式化为人类可读的耗时字符串。
 * < 1s   → "120ms"
 * 1~60s  → "3.2s"
 * > 60s  → "2m 3s"（秒数为 0 则省略）
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

/**
 * 截断字符串到指定长度，超出部分用 ... 替代。
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '...'
}

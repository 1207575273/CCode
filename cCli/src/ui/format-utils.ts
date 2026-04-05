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

/** 最大参数摘要长度 */
const MAX_ARGS_LENGTH = 80

/**
 * 从工具参数中提取人类可读的摘要。
 * 纯逻辑函数，供 pipe-runner（非交互）和 ToolStatusLine（交互 UI）共用。
 */
export function buildArgsSummary(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return ''

  switch (toolName) {
    case 'bash':
      return truncate(String(args['command'] ?? ''), MAX_ARGS_LENGTH)

    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return truncate(String(args['path'] ?? ''), MAX_ARGS_LENGTH)

    case 'grep': {
      const pattern = args['pattern'] ?? ''
      const path = args['path'] ?? '.'
      return truncate(`pattern: "${pattern}", path: ${path}`, MAX_ARGS_LENGTH)
    }

    case 'glob':
      return truncate(String(args['pattern'] ?? ''), MAX_ARGS_LENGTH)

    case 'dispatch_agent':
      return truncate(String(args['description'] ?? ''), MAX_ARGS_LENGTH)

    case 'ask_user_question': {
      const questions = args['questions']
      const count = Array.isArray(questions) ? questions.length : 0
      return `${count} 个问题`
    }

    default: {
      // MCP 等未知工具：提取第一个字符串参数作为摘要
      const firstStringArg = Object.values(args).find(v => typeof v === 'string')
      if (typeof firstStringArg === 'string') {
        return truncate(firstStringArg, MAX_ARGS_LENGTH)
      }
      return ''
    }
  }
}

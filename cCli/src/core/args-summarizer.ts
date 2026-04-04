// src/core/args-summarizer.ts

/**
 * 工具参数摘要 — 为 history 中的 assistant 消息生成精简 args。
 *
 * 设计原则：
 *   1. LLM 能据此回答"我之前做了什么"（行为回忆）
 *   2. 不包含大段内容（write_file 的 content、edit_file 的 old_string 等）
 *   3. 每个工具调用的摘要 token < 50
 *
 * 对比：
 *   args: {}           → LLM 完全丧失参数记忆（之前的做法）
 *   args: 完整 args    → write_file 的 content 可能 2000+ tokens，history 膨胀
 *   args: summarize()  → 保留关键信息，~20 tokens / 调用（本方案）
 */

/** args 摘要中字符串截断上限 */
const PREVIEW_LEN = 80
/** bash command 截断上限（命令是最重要的回忆信息，给多一些） */
const COMMAND_LEN = 300

/**
 * 按工具类型生成 args 精简摘要。
 *
 * 返回的对象结构与原始 args 不同——只保留 LLM 回忆行为所需的最少字段。
 */
export function summarizeArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    // ── 核心工具 ──

    case 'bash':
      // 命令是 bash 的唯一关键信息，完整保留（通常 < 200 字符）
      return {
        command: truncStr(args['command'], COMMAND_LEN),
        ...(args['run_in_background'] === true ? { run_in_background: true } : {}),
        ...(args['timeout'] !== undefined ? { timeout: args['timeout'] } : {}),
      }

    case 'write_file':
      // 路径 + 内容大小（不保留 content 本身）
      return {
        file_path: args['file_path'],
        content_chars: typeof args['content'] === 'string' ? (args['content'] as string).length : 0,
      }

    case 'edit_file':
      // 路径 + old/new 的前 N 字符预览（让 LLM 知道改了什么方向）
      return {
        file_path: args['file_path'],
        old_preview: truncStr(args['old_string'], PREVIEW_LEN),
        new_preview: truncStr(args['new_string'], PREVIEW_LEN),
        ...(args['replace_all'] === true ? { replace_all: true } : {}),
      }

    case 'read_file':
      return {
        file_path: args['file_path'],
        ...(args['offset'] !== undefined ? { offset: args['offset'] } : {}),
        ...(args['limit'] !== undefined ? { limit: args['limit'] } : {}),
      }

    case 'grep':
      return {
        pattern: args['pattern'],
        ...(args['path'] !== undefined ? { path: args['path'] } : {}),
        ...(args['glob'] !== undefined ? { glob: args['glob'] } : {}),
        ...(args['output_mode'] !== undefined ? { output_mode: args['output_mode'] } : {}),
      }

    case 'glob':
      return {
        pattern: args['pattern'],
        ...(args['path'] !== undefined ? { path: args['path'] } : {}),
      }

    // ── 扩展工具 ──

    case 'dispatch_agent':
      return {
        description: args['description'],
        subagent_type: args['subagent_type'] ?? 'general',
        ...(args['name'] !== undefined ? { name: args['name'] } : {}),
        ...(args['run_in_background'] === true ? { run_in_background: true } : {}),
      }

    case 'task_output':
      return {
        ...(args['pid'] !== undefined ? { pid: args['pid'] } : {}),
        ...(args['agent_id'] !== undefined ? { agent_id: args['agent_id'] } : {}),
        ...(args['block'] === true ? { block: true } : {}),
      }

    case 'todo_write':
      // todos 数组可能很长，只记数量
      return {
        count: Array.isArray(args['todos']) ? (args['todos'] as unknown[]).length : 0,
      }

    case 'ask_user_question':
      return {
        question_count: Array.isArray(args['questions']) ? (args['questions'] as unknown[]).length : 0,
      }

    case 'kill_shell':
      return { pid: args['pid'] }

    case 'verify_code':
      return {
        ...(args['command'] !== undefined ? { command: truncStr(args['command'], PREVIEW_LEN) } : {}),
      }

    default:
      // 未知工具（MCP 等）：保留所有 key，大值只记类型和大小
      return summarizeUnknown(args)
  }
}

/** 截断字符串，undefined/非字符串返回 undefined */
function truncStr(val: unknown, maxLen: number): string | undefined {
  if (typeof val !== 'string') return undefined
  if (val.length <= maxLen) return val
  return val.slice(0, maxLen) + '...'
}

/** 未知工具的通用摘要：保留所有 key，大值只记类型和大小 */
function summarizeUnknown(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue
    if (typeof v === 'string') {
      result[k] = v.length > 100 ? `(${v.length} chars)` : v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      result[k] = v
    } else if (Array.isArray(v)) {
      result[k] = `(array, ${v.length} items)`
    } else {
      result[k] = `(${typeof v})`
    }
  }
  return result
}

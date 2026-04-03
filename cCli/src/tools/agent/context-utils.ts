/**
 * SubAgent 上下文工具 — 裁剪主 Agent 历史为子 Agent 构建精简上下文。
 */

import type { Message, MessageContent, ToolCallContent, ToolResultContent } from '@core/types.js'

export interface ContextPolicy {
  /** 'full' = 全量历史, 'trimmed' = 裁剪（默认）, 'none' = 不继承 */
  mode: 'full' | 'trimmed' | 'none'
  /** trimmed 模式：最多保留的消息条数（默认 20） */
  maxMessages?: number
  /** trimmed 模式：估算 token 上限（默认 8000） */
  maxTokenEstimate?: number
}

/**
 * 裁剪主 Agent 历史，为 SubAgent 构建精简上下文。
 *
 * 策略：
 *   1. 截断到最后一个完整的工具调用轮次
 *   2. 保留第一条 user 消息（用户原始需求）
 *   3. 从尾部取最近 maxMessages 条，保持 user/assistant 交替
 *   4. 超过 token 预算时从旧端移除完整轮次
 *   5. 截断超长工具结果
 */
export function trimHistoryForSubAgent(
  history: ReadonlyArray<Message>,
  policy?: ContextPolicy,
): Message[] {
  if (!policy || policy.mode === 'none') return []
  if (history.length === 0) return []

  const { maxMessages = 20, maxTokenEstimate = 8000 } = policy

  // 1. 截断到最后完整轮次
  const clean = policy.mode === 'full' ? [...history] : truncateToCompleteRound(history)
  if (clean.length === 0) return []

  // full 模式：截断超长内容后直接返回
  if (policy.mode === 'full') {
    return clean.map(truncateLongContent)
  }

  // 2. 保留第一条 user（原始需求）
  const firstUser = clean.find(m => m.role === 'user')

  // 3. 从尾部取最近 maxMessages 条，确保起点是 user
  let recent = takeRecent(clean, maxMessages)

  // 4. firstUser 不在 recent 中则插到开头
  if (firstUser && !recent.includes(firstUser)) {
    recent = [firstUser, ...recent]
  }

  // 5. token 预算裁剪
  while (estimateTokens(recent) > maxTokenEstimate && recent.length > 2) {
    // 保留首尾，移除中间最旧的
    recent.splice(1, 1)
  }

  // 6. 截断超长内容
  return recent.map(truncateLongContent)
}

/** 截断到最后一个完整的工具调用轮次 */
function truncateToCompleteRound(history: ReadonlyArray<Message>): Message[] {
  const result = [...history]

  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]!.role !== 'assistant') continue

    const blocks = normalizeContent(result[i]!.content)
    const toolCallIds = new Set(
      blocks
        .filter((b): b is ToolCallContent => b.type === 'tool_call')
        .map(tc => tc.toolCallId),
    )
    if (toolCallIds.size === 0) break // 纯文本 assistant，完整

    // 检查后续消息中是否有全部 tool_result
    for (let j = i + 1; j < result.length; j++) {
      for (const b of normalizeContent(result[j]!.content)) {
        if (b.type === 'tool_result') {
          toolCallIds.delete((b as ToolResultContent).toolCallId)
        }
      }
    }

    if (toolCallIds.size > 0) {
      result.length = i // 不完整，截断到这条 assistant 之前
    }
    break
  }

  return result
}

/** 从尾部取 maxCount 条，确保第一条是 user（保持交替起点） */
function takeRecent(messages: Message[], maxCount: number): Message[] {
  if (messages.length <= maxCount) return [...messages]
  let start = messages.length - maxCount
  // 确保起点是 user 角色
  while (start < messages.length && messages[start]!.role !== 'user') {
    start++
  }
  return messages.slice(start)
}

/** 截断单条消息中的超长内容 */
function truncateLongContent(msg: Message): Message {
  if (typeof msg.content === 'string') {
    return msg.content.length <= 1000 ? msg : { ...msg, content: msg.content.slice(0, 1000) + '\n... (truncated)' }
  }
  if (!Array.isArray(msg.content)) return msg

  const blocks = msg.content.map(block => {
    if (block.type === 'tool_result') {
      const tr = block as ToolResultContent
      const text = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
      if (text.length > 500) {
        return { ...tr, result: text.slice(0, 500) + '\n... (truncated)' }
      }
    }
    if (block.type === 'text') {
      const tb = block as MessageContent & { type: 'text'; text: string }
      if (tb.text.length > 1000) {
        return { ...tb, text: tb.text.slice(0, 1000) + '\n... (truncated)' }
      }
    }
    return block
  })

  return { ...msg, content: blocks }
}

function normalizeContent(content: Message['content']): MessageContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return [content as MessageContent]
}

/** 粗略估算 token 数 */
function estimateTokens(messages: ReadonlyArray<Message>): number {
  let total = 0
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    total += Math.ceil(text.length / 4)
  }
  return total
}

// src/core/message-utils.ts

/**
 * 公共消息操作工具 — 供 provider 转换层、上下文管理、SubAgent 裁剪等模块共用。
 *
 * 消除 normalizeContent / extractText / findToolCalls 等在多处的重复实现。
 */

import type { Message, MessageContent, TextContent, ToolCallContent, ToolResultContent } from './types.js'

/** 将 content 统一为 MessageContent 数组（string → TextContent[]，单对象 → 数组） */
export function normalizeContent(content: Message['content']): MessageContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return [content as MessageContent]
}

/** 从 MessageContent 数组中提取所有文本块并拼接 */
export function extractText(blocks: MessageContent[]): string {
  return blocks
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('')
}

/** 从 MessageContent 数组中提取所有 tool_call 块 */
export function findToolCalls(blocks: MessageContent[]): ToolCallContent[] {
  return blocks.filter((b): b is ToolCallContent => b.type === 'tool_call')
}

/** 从 MessageContent 数组中提取所有 tool_result 块 */
export function findToolResults(blocks: MessageContent[]): ToolResultContent[] {
  return blocks.filter((b): b is ToolResultContent => b.type === 'tool_result')
}

/**
 * 检查 tool_call/tool_result 成对完整性。
 *
 * 返回没有匹配 tool_result 的孤儿 tool_call ID 列表。
 * 空数组表示全部成对。
 */
export function findOrphanToolCalls(messages: ReadonlyArray<Message>): Array<{ toolCallId: string; toolName: string }> {
  const pending = new Map<string, string>()
  for (const msg of messages) {
    for (const b of normalizeContent(msg.content)) {
      if (b.type === 'tool_call') {
        pending.set((b as ToolCallContent).toolCallId, (b as ToolCallContent).toolName)
      }
      if (b.type === 'tool_result') {
        pending.delete((b as ToolResultContent).toolCallId)
      }
    }
  }
  return [...pending.entries()].map(([toolCallId, toolName]) => ({ toolCallId, toolName }))
}

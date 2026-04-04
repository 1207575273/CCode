// src/providers/message-converter.ts
import { HumanMessage, AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { Message, ToolCallContent, ToolResultContent } from '@core/types.js'
import { normalizeContent, extractText, findOrphanToolCalls } from '@core/message-utils.js'

/**
 * 将内部 Message[] 转为 LangChain BaseMessage[]。
 *
 * 支持结构化内容：
 * - assistant 消息中的 tool_call → AIMessage.tool_calls
 * - user 消息中的 tool_result → ToolMessage（每个 tool_result 独立一条）
 */
export function toLangChainMessages(messages: Message[]): BaseMessage[] {
  // Debug 模式下检查消息格式完整性（tool_call/tool_result 成对、无孤儿）
  if (process.env.CCODE_DEBUG) {
    assertToolCallResultPairing(messages)
  }

  const result: BaseMessage[] = []

  for (const msg of messages) {
    const blocks = normalizeContent(msg.content)

    switch (msg.role) {
      case 'system':
        result.push(new SystemMessage(extractText(blocks)))
        break

      case 'assistant': {
        const text = extractText(blocks)
        const toolCalls = blocks
          .filter((b): b is ToolCallContent => b.type === 'tool_call')
          .map(tc => ({ id: tc.toolCallId, name: tc.toolName, args: tc.args }))

        if (toolCalls.length > 0) {
          result.push(new AIMessage({ content: text || '', tool_calls: toolCalls }))
        } else {
          result.push(new AIMessage(text))
        }
        break
      }

      case 'user': {
        const toolResults = blocks.filter((b): b is ToolResultContent => b.type === 'tool_result')
        if (toolResults.length > 0) {
          // 每个 tool_result 转为独立 ToolMessage（OpenAI 格式要求每个 tool_call 对应一条）
          for (const tr of toolResults) {
            result.push(new ToolMessage({
              content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
              tool_call_id: tr.toolCallId,
            }))
          }
          // 如果同时有文本内容（如 PostToolUse feedback），追加为 HumanMessage
          const text = extractText(blocks)
          if (text) result.push(new HumanMessage(text))
        } else {
          result.push(new HumanMessage(extractText(blocks)))
        }
        break
      }

      default:
        result.push(new HumanMessage(extractText(blocks)))
    }
  }

  return result
}

/** Debug 断言：检查 tool_call/tool_result 成对关系（仅 CCODE_DEBUG 时执行） */
function assertToolCallResultPairing(messages: Message[]): void {
  const orphans = findOrphanToolCalls(messages)
  if (orphans.length > 0) {
    const desc = orphans.map(o => `${o.toolName}(${o.toolCallId})`).join(', ')
    console.warn(`[MSG-INTEGRITY] ${orphans.length} tool_call(s) without matching tool_result: ${desc}`)
  }
}

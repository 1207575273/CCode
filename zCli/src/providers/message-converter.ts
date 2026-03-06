// src/providers/message-converter.ts
import { HumanMessage, AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { Message, MessageContent, TextContent } from '@core/types.js'

function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
      .join('')
  }
  const single = content as MessageContent
  if (single.type === 'text') return single.text
  return ''
}

export function toLangChainMessages(messages: Message[]): BaseMessage[] {
  return messages.map(msg => {
    const text = extractText(msg.content)
    switch (msg.role) {
      case 'user':      return new HumanMessage(text)
      case 'assistant': return new AIMessage(text)
      case 'system':    return new SystemMessage(text)
      default:          return new HumanMessage(text)
    }
  })
}

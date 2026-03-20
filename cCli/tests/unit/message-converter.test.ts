import { describe, it, expect } from 'vitest'
import { toLangChainMessages } from '@providers/message-converter.js'
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages'
import type { Message } from '@core/types.js'

describe('toLangChainMessages', () => {
  it('user 消息 → HumanMessage', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }]
    const result = toLangChainMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!).toBeInstanceOf(HumanMessage)
    expect(result[0]!.content).toBe('hello')
  })

  it('assistant 消息 → AIMessage', () => {
    const msgs: Message[] = [{ role: 'assistant', content: 'hi there' }]
    const result = toLangChainMessages(msgs)
    expect(result[0]!).toBeInstanceOf(AIMessage)
  })

  it('system 消息 → SystemMessage', () => {
    const msgs: Message[] = [{ role: 'system', content: 'you are helpful' }]
    const result = toLangChainMessages(msgs)
    expect(result[0]!).toBeInstanceOf(SystemMessage)
  })

  it('TextContent 对象正确提取文本', () => {
    const msgs: Message[] = [
      { role: 'user', content: { type: 'text', text: 'test message' } }
    ]
    const result = toLangChainMessages(msgs)
    expect(result[0]!.content).toBe('test message')
  })

  it('多条消息保持顺序', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]
    const result = toLangChainMessages(msgs)
    expect(result).toHaveLength(3)
    expect(result[0]!).toBeInstanceOf(HumanMessage)
    expect(result[1]!).toBeInstanceOf(AIMessage)
    expect(result[2]!).toBeInstanceOf(HumanMessage)
  })
})

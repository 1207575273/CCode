import { describe, it, expect } from 'vitest'
import type { Message, TokenUsage, StreamChunk } from '@core/types.js'

describe('core types', () => {
  it('Message 类型结构正确', () => {
    const msg: Message = {
      role: 'user',
      content: 'hello',
    }
    expect(msg.role).toBe('user')
  })

  it('TokenUsage 四维字段齐全', () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    }
    expect(Object.keys(usage)).toHaveLength(4)
  })

  it('StreamChunk type 枚举完整', () => {
    const types: StreamChunk['type'][] = ['text', 'tool_call', 'usage', 'done', 'error']
    expect(types).toHaveLength(5)
  })
})

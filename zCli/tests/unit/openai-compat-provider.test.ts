import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@langchain/openai', () => {
  const mockStream = async function* () {
    yield { content: 'GLM ' }
    yield { content: 'reply' }
  }
  return {
    ChatOpenAI: vi.fn().mockImplementation(function () {
      return {
        stream: vi.fn().mockImplementation(mockStream),
        getNumTokens: vi.fn().mockResolvedValue(8),
      }
    }),
  }
})

import { OpenAICompatProvider } from '@providers/openai-compat.js'
import type { ChatRequest } from '@providers/provider.js'

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider

  beforeEach(() => {
    provider = new OpenAICompatProvider('glm', {
      apiKey: 'glm-key',
      baseURL: 'https://open.bigmodel.ai/api/paas/v4',
      models: ['glm-4-flash', 'glm-4'],
    })
  })

  it('name 使用构造函数传入的 providerName', () => {
    expect(provider.name).toBe('glm')
    expect(provider.protocol).toBe('openai-compat')
  })

  it('isModelSupported 仅匹配配置的模型', () => {
    expect(provider.isModelSupported('glm-4-flash')).toBe(true)
    expect(provider.isModelSupported('claude-opus-4-6')).toBe(false)
  })

  it('chat 流式返回正确内容', async () => {
    const req: ChatRequest = {
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }
    const chunks = []
    for await (const chunk of provider.chat(req)) {
      chunks.push(chunk)
    }
    const text = chunks.filter(c => c.type === 'text').map(c => c.text).join('')
    expect(text).toBe('GLM reply')
    expect(chunks.at(-1)?.type).toBe('done')
  })
})

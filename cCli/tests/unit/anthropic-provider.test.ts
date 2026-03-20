import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @anthropic-ai/sdk BEFORE importing provider
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        messages: {
          stream: vi.fn().mockImplementation(() => {
            // 默认：返回纯文本流
            const events = [
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } },
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
            ]
            const finalMessage = {
              content: [{ type: 'text', text: 'hello world' }],
              usage: { input_tokens: 10, output_tokens: 5 },
              stop_reason: 'end_turn',
            }
            return {
              [Symbol.asyncIterator]: async function* () {
                for (const e of events) yield e
              },
              finalMessage: async () => finalMessage,
            }
          }),
        },
      }
    }),
  }
})

import { AnthropicProvider } from '@providers/anthropic.js'
import type { ChatRequest } from '@providers/provider.js'

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider

  beforeEach(() => {
    provider = new AnthropicProvider('anthropic', {
      apiKey: 'sk-test',
      models: ['claude-sonnet-4-6'],
    })
  })

  it('name 和 protocol 正确', () => {
    expect(provider.name).toBe('anthropic')
    expect(provider.protocol).toBe('native-anthropic')
  })

  it('isModelSupported 仅匹配配置的模型', () => {
    expect(provider.isModelSupported('claude-sonnet-4-6')).toBe(true)
    expect(provider.isModelSupported('gpt-4o')).toBe(false)
  })

  it('chat 流式返回 text chunks 和 done', async () => {
    const req: ChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    }
    const chunks = []
    for await (const chunk of provider.chat(req)) {
      chunks.push(chunk)
    }
    const textChunks = chunks.filter(c => c.type === 'text')
    const doneChunks = chunks.filter(c => c.type === 'done')
    const usageChunks = chunks.filter(c => c.type === 'usage')
    expect(textChunks.length).toBeGreaterThan(0)
    expect(doneChunks).toHaveLength(1)
    expect(usageChunks).toHaveLength(1)
    const fullText = textChunks.map(c => c.text).join('')
    expect(fullText).toBe('hello world')
  })

  it('chat 带 tools 时返回 tool_call chunk', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    vi.mocked(Anthropic).mockImplementationOnce(function () {
      return {
        messages: {
          stream: vi.fn().mockImplementation(() => {
            const events = [
              { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
            ]
            const finalMessage = {
              content: [
                { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
              stop_reason: 'tool_use',
            }
            return {
              [Symbol.asyncIterator]: async function* () {
                for (const e of events) yield e
              },
              finalMessage: async () => finalMessage,
            }
          }),
        },
      } as unknown as InstanceType<typeof Anthropic>
    })

    // 需要新建 provider 让 mock 生效
    const p = new AnthropicProvider('anthropic', {
      apiKey: 'sk-test',
      models: ['claude-sonnet-4-6'],
    })

    const req: ChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'read foo.ts' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    }
    const chunks = []
    for await (const chunk of p.chat(req)) {
      chunks.push(chunk)
    }
    const toolChunks = chunks.filter(c => c.type === 'tool_call')
    expect(toolChunks).toHaveLength(1)
    expect((toolChunks[0] as { type: string; toolCall?: { toolName: string } })?.toolCall?.toolName).toBe('read_file')
  })

  it('第三方 provider 使用 baseURL + authToken', async () => {
    const Anthropic = vi.mocked((await import('@anthropic-ai/sdk')).default)
    Anthropic.mockClear()

    new AnthropicProvider('minimax', {
      apiKey: 'mm-key',
      baseURL: 'https://api.minimaxi.com/anthropic',
      protocol: 'anthropic',
      models: ['MiniMax-M2.5'],
    })

    expect(Anthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.minimaxi.com/anthropic',
        apiKey: 'mm-key',
        defaultHeaders: { 'Authorization': 'Bearer mm-key' },
      }),
    )
  })
})

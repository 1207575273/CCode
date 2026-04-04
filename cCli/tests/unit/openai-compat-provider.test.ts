import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@langchain/openai', () => {
  const makeChunk = (content: string) => ({
    content,
    tool_calls: [] as unknown[],
    concat(other: { content: string; tool_calls: unknown[] }) {
      return makeChunk(this.content + other.content)
    },
  })
  const mockStream = async function* () {
    yield makeChunk('GLM ')
    yield makeChunk('reply')
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

  it('chat 带 tools 时返回 tool_call chunk', async () => {
    const { ChatOpenAI } = await import('@langchain/openai')
    const mockChunkWithTool = {
      content: '',
      tool_calls: [{ name: 'read_file', args: { path: 'bar.ts' }, id: 'call_2' }],
      concat: (_other: unknown) => mockChunkWithTool,
    }
    vi.mocked(ChatOpenAI).mockImplementationOnce(function () {
      return {
        bindTools: vi.fn().mockReturnThis(),
        stream: vi.fn().mockImplementation(async function* () {
          yield mockChunkWithTool
        }),
        getNumTokens: vi.fn().mockResolvedValue(5),
      } as unknown as InstanceType<typeof ChatOpenAI>
    })

    const req: ChatRequest = {
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: 'read bar.ts' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    }
    const chunks = []
    for await (const chunk of provider.chat(req)) {
      chunks.push(chunk)
    }
    const toolChunks = chunks.filter(c => c.type === 'tool_call')
    expect(toolChunks).toHaveLength(1)
    expect((toolChunks[0] as { type: string; toolCall?: { toolName: string } })?.toolCall?.toolName).toBe('read_file')
  })

  /**
   * GLM 兼容性关键测试：tool_calls 在 additional_kwargs 中的 fallback
   *
   * 某些 OpenAI 兼容 API（GLM-5.1 等）通过 LangChain 流式调用时，
   * chunk 聚合后 final.tool_calls 为空，但 finish_reason = 'tool_calls'，
   * 真正的工具调用数据藏在 additional_kwargs.tool_calls 中。
   *
   * 如果不做 fallback 提取，AgentLoop 收到 toolCalls.length === 0 → 判定完成 → 停机。
   * 这就是主 Agent "干到一半就停"的直接原因。
   */
  it('GLM fallback: tool_calls 在 additional_kwargs 时正确提取', async () => {
    const { ChatOpenAI } = await import('@langchain/openai')

    const mockFinal = {
      content: '让我查看文件',
      tool_calls: [],
      additional_kwargs: {
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"src/main.ts"}' },
          },
        ],
      },
      response_metadata: { finish_reason: 'tool_calls' },
      usage_metadata: { input_tokens: 100, output_tokens: 50 },
      concat: (_other: unknown) => mockFinal,
    }

    vi.mocked(ChatOpenAI).mockImplementationOnce(function () {
      return {
        bindTools: vi.fn().mockReturnThis(),
        stream: vi.fn().mockImplementation(async function* () { yield mockFinal }),
        getNumTokens: vi.fn().mockResolvedValue(5),
      } as unknown as InstanceType<typeof ChatOpenAI>
    })

    const req: ChatRequest = {
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: 'read main.ts' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    }

    const chunks = []
    for await (const chunk of provider.chat(req)) { chunks.push(chunk) }

    const toolChunks = chunks.filter(c => c.type === 'tool_call')
    expect(toolChunks).toHaveLength(1)
    expect(toolChunks[0]!.toolCall!.toolName).toBe('read_file')
    expect(toolChunks[0]!.toolCall!.toolCallId).toBe('call_abc123')
    expect(toolChunks[0]!.toolCall!.args).toEqual({ file_path: 'src/main.ts' })
  })

  it('GLM fallback: additional_kwargs 中多个工具全部提取', async () => {
    const { ChatOpenAI } = await import('@langchain/openai')

    const mockFinal = {
      content: '',
      tool_calls: [],
      additional_kwargs: {
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"useState"}' } },
          { id: 'call_2', type: 'function', function: { name: 'glob', arguments: '{"pattern":"**/*.tsx"}' } },
        ],
      },
      response_metadata: { finish_reason: 'tool_calls' },
      concat: (_other: unknown) => mockFinal,
    }

    vi.mocked(ChatOpenAI).mockImplementationOnce(function () {
      return {
        bindTools: vi.fn().mockReturnThis(),
        stream: vi.fn().mockImplementation(async function* () { yield mockFinal }),
        getNumTokens: vi.fn().mockResolvedValue(5),
      } as unknown as InstanceType<typeof ChatOpenAI>
    })

    const req: ChatRequest = {
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ name: 'grep', description: 's', parameters: {} }, { name: 'glob', description: 'f', parameters: {} }],
    }

    const chunks = []
    for await (const chunk of provider.chat(req)) { chunks.push(chunk) }

    const toolChunks = chunks.filter(c => c.type === 'tool_call')
    expect(toolChunks).toHaveLength(2)
    expect(toolChunks[0]!.toolCall!.toolName).toBe('grep')
    expect(toolChunks[1]!.toolCall!.toolName).toBe('glob')
  })

  it('tool_calls 正常在顶层时不触发 fallback', async () => {
    const { ChatOpenAI } = await import('@langchain/openai')

    const mockFinal = {
      content: '',
      tool_calls: [{ name: 'bash', args: { command: 'ls' }, id: 'call_ok' }],
      additional_kwargs: {},
      response_metadata: { finish_reason: 'tool_calls' },
      concat: (_other: unknown) => mockFinal,
    }

    vi.mocked(ChatOpenAI).mockImplementationOnce(function () {
      return {
        bindTools: vi.fn().mockReturnThis(),
        stream: vi.fn().mockImplementation(async function* () { yield mockFinal }),
        getNumTokens: vi.fn().mockResolvedValue(5),
      } as unknown as InstanceType<typeof ChatOpenAI>
    })

    const req: ChatRequest = {
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: 'ls' }],
      tools: [{ name: 'bash', description: 'run', parameters: {} }],
    }

    const chunks = []
    for await (const chunk of provider.chat(req)) { chunks.push(chunk) }

    const toolChunks = chunks.filter(c => c.type === 'tool_call')
    expect(toolChunks).toHaveLength(1)
    expect(toolChunks[0]!.toolCall!.toolName).toBe('bash')
    expect(toolChunks[0]!.toolCall!.toolCallId).toBe('call_ok')
  })
})

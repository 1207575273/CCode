// src/providers/anthropic.ts
import { ChatAnthropic } from '@langchain/anthropic'
import { toLangChainMessages } from './message-converter.js'
import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, StreamChunk } from '@core/types.js'
import type { ProviderConfig } from '@config/config-manager.js'
import { dbg } from '../debug.js'

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly protocol: ProviderProtocol = 'native-anthropic'

  readonly #config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.#config = config
  }

  isModelSupported(model: string): boolean {
    return this.#config.models.includes(model)
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const baseModel = new ChatAnthropic({
      apiKey: this.#config.apiKey,
      model: request.model,
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    })

    // 有工具时绑定，转换为 Anthropic tool 标准格式
    const model = (request.tools && request.tools.length > 0)
      ? baseModel.bindTools(request.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })))
      : baseModel

    const langchainMsgs = toLangChainMessages(request.messages)

    dbg(`[DEBUG][anthropic] chat request:\n`)
    dbg(`  model: ${request.model}\n`)
    dbg(`  messages: ${JSON.stringify(request.messages, null, 2)}\n`)

    try {
      const streamOpts = request.signal !== undefined ? { signal: request.signal } : {}
      const stream = await model.stream(langchainMsgs, streamOpts)

      dbg(`[DEBUG][anthropic] stream opened, receiving chunks...\n`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allChunks: any[] = []
      for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : ''
        dbg(`[DEBUG][anthropic] chunk: ${JSON.stringify(chunk)}\n`)
        if (text) {
          yield { type: 'text', text }
        }
        allChunks.push(chunk)
      }

      // 聚合 chunk，提取 tool_calls 和 usage
      if (allChunks.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const final = allChunks.reduce((a: any, b: any) => a.concat(b))

        // F9: 提取 usage 信息（LangChain Anthropic 在 usage_metadata 或 response_metadata.usage 中）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usageMeta = (final as any).usage_metadata ?? (final as any).response_metadata?.usage ?? null
        if (usageMeta) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usageMeta.input_tokens ?? usageMeta.prompt_tokens ?? 0,
              outputTokens: usageMeta.output_tokens ?? usageMeta.completion_tokens ?? 0,
              cacheReadTokens: usageMeta.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usageMeta.cache_creation_input_tokens ?? 0,
            },
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const tc of (final.tool_calls ?? []) as any[]) {
          yield {
            type: 'tool_call',
            toolCall: {
              type: 'tool_call',
              toolCallId: tc.id ?? '',
              toolName: tc.name,
              args: tc.args as Record<string, unknown>,
            },
          }
        }
      }

      yield { type: 'done' }
    } catch (err) {
      dbg(`[DEBUG][anthropic] error: ${err}\n`)
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    const model = new ChatAnthropic({
      apiKey: this.#config.apiKey,
      model: this.#config.models[0] ?? 'claude-sonnet-4-6',
    })
    return model.getNumTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' '))
  }
}

// src/providers/anthropic.ts
import { ChatAnthropic } from '@langchain/anthropic'
import { toLangChainMessages } from './message-converter.js'
import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, StreamChunk } from '@core/types.js'
import type { ProviderConfig } from '@config/config-manager.js'

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly protocol: ProviderProtocol = 'native-anthropic'

  private readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  isModelSupported(model: string): boolean {
    return this.config.models.includes(model)
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const model = new ChatAnthropic({
      apiKey: this.config.apiKey,
      model: request.model,
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    })

    const langchainMsgs = toLangChainMessages(request.messages)

    try {
      const streamOpts = request.signal !== undefined ? { signal: request.signal } : {}
      const stream = await model.stream(langchainMsgs, streamOpts)

      for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : ''
        if (text) {
          yield { type: 'text', text }
        }
      }

      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    const model = new ChatAnthropic({
      apiKey: this.config.apiKey,
      model: this.config.models[0] ?? 'claude-sonnet-4-6',
    })
    return model.getNumTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' '))
  }
}

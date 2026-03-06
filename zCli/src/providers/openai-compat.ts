// src/providers/openai-compat.ts
import { ChatOpenAI } from '@langchain/openai'
import { toLangChainMessages } from './message-converter.js'
import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, StreamChunk } from '@core/types.js'
import type { ProviderConfig } from '@config/config-manager.js'

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string
  readonly protocol: ProviderProtocol = 'openai-compat'

  private readonly config: ProviderConfig

  constructor(providerName: string, config: ProviderConfig) {
    this.name = providerName
    this.config = config
  }

  isModelSupported(model: string): boolean {
    return this.config.models.includes(model)
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const model = new ChatOpenAI({
      apiKey: this.config.apiKey,
      model: request.model,
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(this.config.baseURL !== undefined && { configuration: { baseURL: this.config.baseURL } }),
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
    const model = new ChatOpenAI({
      apiKey: this.config.apiKey,
      model: this.config.models[0] ?? 'gpt-4o-mini',
    })
    return model.getNumTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' '))
  }
}

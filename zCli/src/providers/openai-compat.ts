// src/providers/openai-compat.ts
import { ChatOpenAI } from '@langchain/openai'
import { toLangChainMessages } from './message-converter.js'
import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, StreamChunk } from '@core/types.js'
import type { ProviderConfig } from '@config/config-manager.js'
import { dbg } from '../debug.js'

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string
  readonly protocol: ProviderProtocol = 'openai-compat'

  readonly #config: ProviderConfig

  constructor(providerName: string, config: ProviderConfig) {
    this.name = providerName
    this.#config = config
  }

  isModelSupported(model: string): boolean {
    return this.#config.models.includes(model)
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const baseModel = new ChatOpenAI({
      apiKey: this.#config.apiKey,
      model: request.model,
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(this.#config.baseURL !== undefined && { configuration: { baseURL: this.#config.baseURL } }),
    })

    // 有工具时绑定，转换为 OpenAI function calling 标准格式
    const model = (request.tools && request.tools.length > 0)
      ? baseModel.bindTools(request.tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })))
      : baseModel

    const langchainMsgs = toLangChainMessages(request.messages)

    dbg(`[DEBUG][${this.name}] chat request:\n`)
    dbg(`  model: ${request.model}\n`)
    dbg(`  baseURL: ${this.#config.baseURL ?? '(default)'}\n`)
    dbg(`  messages: ${JSON.stringify(request.messages, null, 2)}\n`)

    try {
      const streamOpts = request.signal !== undefined ? { signal: request.signal } : {}
      const stream = await model.stream(langchainMsgs, streamOpts)

      dbg(`[DEBUG][${this.name}] stream opened, receiving chunks...\n`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allChunks: any[] = []
      for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : ''
        dbg(`[DEBUG][${this.name}] chunk: ${JSON.stringify(chunk)}\n`)
        if (text) {
          yield { type: 'text', text }
        }
        allChunks.push(chunk)
      }

      // 聚合 chunk，提取 tool_calls
      if (allChunks.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const final = allChunks.reduce((a: any, b: any) => a.concat(b))
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
      dbg(`[DEBUG][${this.name}] error: ${err}\n`)
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    const model = new ChatOpenAI({
      apiKey: this.#config.apiKey,
      model: this.#config.models[0] ?? 'gpt-4o-mini',
    })
    return model.getNumTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' '))
  }
}

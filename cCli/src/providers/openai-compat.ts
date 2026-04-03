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
  /** 会话级缓存的 ChatOpenAI 实例 */
  #chatModel: ChatOpenAI | null = null
  #chatModelName: string | null = null
  #disposed = false

  constructor(providerName: string, config: ProviderConfig) {
    this.name = providerName
    this.#config = config
  }

  /** 为每个 AgentLoop 创建独立的会话级 Provider（共享 config，独立缓存） */
  createSession(): OpenAICompatProvider {
    return new OpenAICompatProvider(this.name, this.#config)
  }

  /** 释放 ChatOpenAI 实例及其内部连接资源 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#chatModel = null
    this.#chatModelName = null
  }

  /** 获取或创建当前 session 的 ChatOpenAI 实例 */
  #getOrCreateModel(model: string): ChatOpenAI {
    if (this.#disposed) throw new Error('SessionProvider already disposed')
    if (this.#chatModel && this.#chatModelName === model) return this.#chatModel
    this.#chatModel = new ChatOpenAI({
      apiKey: this.#config.apiKey,
      model,
      ...(this.#config.baseURL !== undefined && {
        configuration: { baseURL: this.#config.baseURL, apiKey: this.#config.apiKey },
      }),
    })
    this.#chatModelName = model
    return this.#chatModel
  }

  isModelSupported(model: string): boolean {
    return this.#config.models.includes(model)
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const baseModel = this.#getOrCreateModel(request.model)

    // 有工具时绑定，转换为 OpenAI function calling 标准格式
    const model = (request.tools && request.tools.length > 0)
      ? baseModel.bindTools(request.tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })))
      : baseModel

    // System Prompt 注入：作为首条 system message 发送给 LLM
    const messagesWithSystem = request.systemPrompt
      ? [{ role: 'system' as const, content: request.systemPrompt }, ...request.messages]
      : request.messages
    const langchainMsgs = toLangChainMessages(messagesWithSystem)

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

      // 聚合 chunk，提取 tool_calls 和 usage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finishReason = 'stop'
      if (allChunks.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const final = allChunks.reduce((a: any, b: any) => a.concat(b))

        // F9: 提取 usage 信息（LangChain OpenAI 在 usage_metadata 或 response_metadata.usage 中）
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

        // 从 LangChain response_metadata 提取 finish_reason（fallback 链）
        finishReason = (final as any).response_metadata?.finish_reason
          ?? (final as any).additional_kwargs?.finish_reason
          ?? (final.tool_calls?.length > 0 ? 'tool_calls' : 'stop')
      }

      yield { type: 'done', stopReason: finishReason }
    } catch (err) {
      dbg(`[DEBUG][${this.name}] error: ${err}\n`)
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    const model = this.#getOrCreateModel(this.#config.models[0] ?? 'gpt-4o-mini')
    return model.getNumTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' '))
  }
}

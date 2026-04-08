// src/providers/openai-compat.ts
import { ChatOpenAI } from '@langchain/openai'
import { toLangChainMessages } from './message-converter.js'
import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, StreamChunk } from '@core/types.js'
import type { ProviderConfig } from '@config/config-manager.js'
import { dbg } from '../debug.js'
import { withRetry, friendlyErrorMessage } from './retry.js'

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
      // 开启流式 usage 返回，否则 stream 模式下 usage_metadata 为空
      // LangChain 底层会自动在请求中加 stream_options: { include_usage: true }
      streamUsage: true,
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
    dbg(`  langchainMsgs: ${JSON.stringify(langchainMsgs.map(m => ({ type: m._getType(), content: m.content })), null, 2)}\n`)

    // withRetry 包装：在连接建立阶段自动重试 429/5xx/网络错误
    const providerName = this.name
    const createStream = () => this.#chatOnce(model, langchainMsgs, request)
    try {
      yield* withRetry(createStream, providerName)
    } catch (err) {
      dbg(`[DEBUG][${providerName}] error after retries: ${err}\n`)
      yield { type: 'error', error: friendlyErrorMessage(err instanceof Error ? err : new Error(String(err))) }
    }
  }

  /** 单次 LLM 调用（不含重试），供 withRetry 包装 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *#chatOnce(model: any, langchainMsgs: any[], request: ChatRequest): AsyncIterable<StreamChunk> {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let finishReason = 'stop'
    if (allChunks.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const final = allChunks.reduce((a: any, b: any) => a.concat(b))

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
      let rawToolCalls = (final.tool_calls ?? []) as any[]
      const inferredFinish = (final as any).response_metadata?.finish_reason ?? ''

      // GLM 兼容性处理：流式模式下 tool_calls 可能丢失
      if (rawToolCalls.length === 0 && inferredFinish === 'tool_calls') {
        // fallback 1：从 additional_kwargs 提取
        const fallbackCalls = ((final as any).additional_kwargs?.tool_calls ?? []) as any[]
        if (fallbackCalls.length > 0) {
          dbg(`[WARN][${this.name}] finish_reason=tool_calls but final.tool_calls empty, recovered from additional_kwargs (${fallbackCalls.length} calls)\n`)
          for (const tc of fallbackCalls) {
            const funcArgs = tc.function?.arguments
            rawToolCalls.push({
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: typeof funcArgs === 'string' ? JSON.parse(funcArgs) : (funcArgs ?? {}),
            })
          }
        } else {
          // fallback 2：invoke 非流式重试
          dbg(`[WARN][${this.name}] finish_reason=tool_calls but NO tool data in stream. Retrying with invoke (non-streaming)...\n`)
          try {
            const invokeOpts = request.signal !== undefined ? { signal: request.signal } : {}
            const invokeResult = await model.invoke(langchainMsgs, invokeOpts)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const invokeCalls = ((invokeResult as any).tool_calls ?? []) as any[]
            if (invokeCalls.length > 0) {
              dbg(`[INFO][${this.name}] invoke fallback recovered ${invokeCalls.length} tool_calls\n`)
              rawToolCalls = invokeCalls
            } else {
              const invokeKwargsCalls = ((invokeResult as any).additional_kwargs?.tool_calls ?? []) as any[]
              for (const tc of invokeKwargsCalls) {
                const funcArgs = tc.function?.arguments
                rawToolCalls.push({
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  args: typeof funcArgs === 'string' ? JSON.parse(funcArgs) : (funcArgs ?? {}),
                })
              }
              if (rawToolCalls.length > 0) {
                dbg(`[INFO][${this.name}] invoke fallback recovered ${rawToolCalls.length} tool_calls from additional_kwargs\n`)
              } else {
                dbg(`[WARN][${this.name}] invoke fallback also returned no tool_calls. Giving up.\n`)
              }
            }
          } catch (retryErr) {
            dbg(`[ERROR][${this.name}] invoke fallback failed: ${retryErr}\n`)
          }
        }
      }
      for (const tc of rawToolCalls) {
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

      finishReason = (final as any).response_metadata?.finish_reason
        ?? (final as any).additional_kwargs?.finish_reason
        ?? (final.tool_calls?.length > 0 ? 'tool_calls' : 'stop')
    }

    yield { type: 'done', stopReason: finishReason }
  }

  async countTokens(messages: Message[]): Promise<number> {
    const model = this.#getOrCreateModel(this.#config.models[0] ?? 'gpt-4o-mini')
    return model.getNumTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' '))
  }
}

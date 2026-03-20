// src/providers/wrapper.ts

/**
 * Provider 代理层 — 包装底层 Provider，统一拦截 chat() 的流式输出。
 *
 * 当前职责：
 * - 从 done chunk 的 stopReason 做标准化映射（Anthropic/OpenAI 命名统一）
 *
 * 未来可扩展：
 * - 429 限流自动重试
 * - 模型降级（主模型不可用 → 备选模型）
 * - Token 预算控制
 * - 响应缓存
 */

import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, StreamChunk } from '@core/types.js'

/** 将各 Provider 的 stopReason 标准化为统一枚举 */
function normalizeStopReason(raw: string): string {
  switch (raw) {
    case 'end_turn':       return 'end_turn'
    case 'tool_use':       return 'tool_use'
    case 'max_tokens':     return 'max_tokens'
    case 'stop_sequence':  return 'stop_sequence'
    case 'stop':           return 'end_turn'
    case 'tool_calls':     return 'tool_use'
    case 'length':         return 'max_tokens'
    case 'content_filter': return 'content_filter'
    case 'abort':          return 'abort'
    default:               return raw
  }
}

export class ProviderWrapper implements LLMProvider {
  readonly name: string
  readonly protocol: ProviderProtocol
  readonly #inner: LLMProvider

  constructor(inner: LLMProvider) {
    this.#inner = inner
    this.name = inner.name
    this.protocol = inner.protocol
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    for await (const chunk of this.#inner.chat(request)) {
      if (chunk.type === 'done' && chunk.stopReason) {
        yield { ...chunk, stopReason: normalizeStopReason(chunk.stopReason) }
      } else {
        yield chunk
      }
    }
  }

  countTokens(messages: Message[]): Promise<number> {
    return this.#inner.countTokens(messages)
  }

  isModelSupported(model: string): boolean {
    return this.#inner.isModelSupported(model)
  }
}

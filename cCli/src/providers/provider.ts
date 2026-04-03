// src/providers/provider.ts

import type { Message, StreamChunk } from '@core/types.js'

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  signal?: AbortSignal
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export type ProviderProtocol = 'openai-compat' | 'native-anthropic' | 'native-google'

export interface ProviderConfig {
  name: string
  protocol: ProviderProtocol
  baseURL?: string
  apiKey: string
  models: string[]
}

export interface LLMProvider {
  readonly name: string
  readonly protocol: ProviderProtocol

  chat(request: ChatRequest): AsyncIterable<StreamChunk>
  countTokens(messages: Message[]): Promise<number>
  isModelSupported(model: string): boolean

  /**
   * 创建绑定到 AgentLoop 生命周期的会话级 Provider。
   * 会话级 Provider 在内部缓存有状态资源（如 LangChain ChatOpenAI 实例），
   * AgentLoop 结束时必须调用 dispose() 释放。
   * 无状态 Provider（如 Anthropic SDK）可返回 this。
   */
  createSession?(): LLMProvider

  /**
   * 释放会话级资源（httpAgent、连接池等）。
   * AgentLoop 结束时（正常/异常/中断）必须在 finally 中调用。
   */
  dispose?(): void
}

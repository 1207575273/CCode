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
}

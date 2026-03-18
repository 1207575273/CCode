// src/core/types.ts

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolCallContent {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  toolCallId: string
  result: unknown
  isError?: boolean
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent

export interface Message {
  role: Role
  content: MessageContent | MessageContent[] | string
  id?: string
  createdAt?: Date
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'usage' | 'done' | 'error' | 'thinking'
  text?: string
  /** 思考过程内容（thinking 类型时有值） */
  thinking?: string
  toolCall?: ToolCallContent
  usage?: TokenUsage
  error?: string
  /** LLM 调用结束原因（done 类型时有值） */
  stopReason?: string
}

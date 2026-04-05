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

/** 图片内容块（多模态消息，Provider 层读取 base64 时使用 imageId 查找文件） */
export interface ImageContent {
  type: 'image'
  imageId: string     // 图片文件 UUID 引用
  mediaType: string   // image/jpeg | image/png | image/webp
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent | ImageContent

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

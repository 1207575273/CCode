// src/types.ts

/** 服务端推送的事件 */
export type ServerEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done'; toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown> }
  | { type: 'error'; error: string }
  | { type: 'done' }
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'llm_start'; provider: string; model: string }
  | { type: 'llm_usage'; inputTokens: number; outputTokens: number }

/** 客户端发送的消息 */
export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'permission'; allow: boolean }
  | { type: 'abort' }

/** 聊天消息（UI 渲染用） */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  source?: 'cli' | 'web'
}

/** 工具执行状态 */
export interface ToolEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: 'running' | 'done'
  durationMs?: number
  success?: boolean
  resultSummary?: string
}

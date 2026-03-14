// src/types.ts

/** 问卷选项 */
export interface QuestionOption {
  label: string
  description?: string
}

/** 单个问题定义 */
export interface UserQuestion {
  key: string
  title: string
  type: 'select' | 'multiselect' | 'text'
  options?: QuestionOption[]
  placeholder?: string
}

/** 历史消息（session JSONL 还原） */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/** 服务端推送的事件 */
export type ServerEvent =
  | { type: 'session_init'; sessionId: string; provider?: string; model?: string; messages: SessionMessage[] }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done'; toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown> }
  | { type: 'user_question_request'; questions: UserQuestion[] }
  | { type: 'error'; error: string }
  | { type: 'done' }
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'llm_start'; provider: string; model: string }
  | { type: 'llm_usage'; inputTokens: number; outputTokens: number }

/** 客户端发送的消息 */
export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'permission'; allow: boolean }
  | { type: 'question'; cancelled: boolean; answers?: Record<string, string | string[]> }
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

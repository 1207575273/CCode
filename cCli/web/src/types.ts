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

/** 历史消息（session JSONL 还原，含工具执行记录） */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolEvents?: ToolEvent[]
  model?: string
  provider?: string
  /** 思考过程（extended thinking） */
  thinking?: string
  /** 本轮 token 用量 */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  /** 本轮 LLM 调用次数 */
  llmCallCount?: number
  /** 本轮工具调用次数 */
  toolCallCount?: number
}

/** 服务端推送的事件 */
export type ServerEvent =
  | { type: 'session_init'; sessionId: string; provider?: string; model?: string; messages: SessionMessage[]; subagents?: SubagentSnapshot[]; cliConnected?: boolean; activeSessionId?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done'; toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown> }
  | { type: 'user_question_request'; questions: UserQuestion[] }
  | { type: 'error'; error: string }
  | { type: 'done' }
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'llm_start'; provider: string; model: string }
  | { type: 'llm_done'; inputTokens: number; outputTokens: number; stopReason?: string }
  | { type: 'bridge_stop' }
  | { type: 'context_update'; usedPercentage: number; lastInputTokens: number; effectiveWindow: number; level: string }
  | { type: 'compact_status'; status: 'start' | 'done' | 'error'; strategy?: string; message?: string }
  | { type: 'cli_status'; connected: boolean; sessionId: string }
  | { type: 'todo_update'; todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'subagent_progress'; agentId: string; description: string; turn: number; maxTurns: number; currentTool?: string }
  | { type: 'subagent_done'; agentId: string; description: string; success: boolean; output: string }
  | { type: 'subagent_event'; agentId: string; detail: { kind: 'tool_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> } | { kind: 'tool_done'; toolName: string; toolCallId: string; durationMs?: number; success?: boolean; resultSummary?: string } | { kind: 'text'; text: string } | { kind: 'error'; error: string } }

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
  /** assistant 消息的工具执行记录（结构化，支持折叠渲染） */
  toolEvents?: ToolEvent[]
  /** assistant 消息的模型名 */
  model?: string
  /** assistant 消息的供应商名 */
  provider?: string
  /** 思考过程（extended thinking） */
  thinking?: string
  /** 本轮 token 用量 */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  /** 本轮 LLM 调用次数 */
  llmCallCount?: number
  /** 本轮工具调用次数 */
  toolCallCount?: number
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
  resultFull?: string
}

/** SubAgent JSONL 回放快照（session_init 携带） */
export interface SubagentSnapshot {
  agentId: string
  description: string
  status: 'running' | 'done' | 'error'
  events: Array<
    | { kind: 'tool_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> }
    | { kind: 'tool_done'; toolName: string; toolCallId: string; durationMs?: number; success?: boolean; resultSummary?: string }
    | { kind: 'text'; text: string }
    | { kind: 'error'; error: string }
  >
}

/** 记忆向量 API 响应 */
export interface MemoryVectorsResponse {
  chunks: Array<{
    id: string
    entryId: string
    title: string
    scope: 'global' | 'project'
    type: string
    tags: string[]
    chunkText: string
    chunkIndex: number
    embedding: number[]
  }>
  systemPrompt: {
    totalTokens: number
    sections: Array<{
      name: string
      tokens: number
      source: string
    }>
  }
  dimension: number
}

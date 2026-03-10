// src/persistence/session-types.ts

import type { TokenUsage, MessageContent } from '@core/types.js'

export type SessionEventType =
  // 已有
  | 'session_start'
  | 'session_resume'
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool_call'
  | 'tool_result'
  | 'turn_duration'
  // F9 新增：观测事件
  | 'llm_call_start'
  | 'llm_call_end'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'mcp_connect_start'
  | 'mcp_connect_end'
  | 'tool_fallback'
  | 'permission_grant'
  | 'error'
  | 'session_end'

export interface SessionEvent {
  sessionId: string
  type: SessionEventType
  timestamp: string // ISO 8601
  uuid: string // 本条事件 ID
  parentUuid: string | null // 上一条事件 ID
  cwd: string
  gitBranch?: string
  message?: {
    role: string
    content: string | MessageContent[]
    model?: string
    usage?: TokenUsage
  }
  provider?: string
  model?: string
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: string
  isError?: boolean
  error?: string
  durationMs?: number

  // F9 新增字段
  /** LLM 调用相关 */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  stopReason?: string        // 'end_turn' | 'max_tokens' | 'abort' | 'error'
  messageCount?: number      // 发送给 LLM 的消息数

  /** 工具/MCP 相关 */
  success?: boolean
  resultSummary?: string     // 结果摘要（截断）
  serverName?: string
  transport?: string
  toolCount?: number         // MCP 发现的工具数

  /** 降级相关 */
  fromLevel?: string
  toLevel?: string
  reason?: string

  /** 权限相关 */
  always?: boolean

  /** 异常相关 */
  source?: string            // 'llm' | 'tool' | 'mcp' | 'system'
  stack?: string

  /** 会话汇总 (session_end) */
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalToolCalls?: number
  totalLlmCalls?: number
  totalErrors?: number
  totalDurationMs?: number
}

export interface SessionSnapshot {
  sessionId: string
  provider: string
  model: string
  cwd: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
  /** 当前分支的叶节点 UUID */
  leafEventUuid: string | null
}

/** 分支信息，每个叶节点代表一个分支 */
export interface BranchInfo {
  /** 分支末端事件 UUID */
  leafEventUuid: string
  /** 分支末尾消息预览（截断） */
  lastMessage: string
  /** 该分支上 user+assistant 消息数 */
  messageCount: number
  /** 叶节点时间戳 */
  updatedAt: string
  /** 分叉点事件 UUID（与主干分开的位置，主干无分叉点） */
  forkPoint: string | null
}

export interface SessionSummary {
  sessionId: string
  projectSlug: string
  firstMessage: string
  updatedAt: string
  gitBranch: string
  fileSize: number
  filePath: string
}

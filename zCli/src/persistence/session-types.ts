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
  | 'compact'
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
    provider?: string
    usage?: TokenUsage
    /** assistant 消息本轮累计 token 用量 */
    assistantUsage?: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
    /** LLM 停止原因 */
    stopReason?: string
    /** 本轮 LLM 调用次数 */
    llmCallCount?: number
    /** 本轮工具调用次数 */
    toolCallCount?: number
    /** 思考过程（extended thinking） */
    thinking?: string
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

  /** 子 Agent 标记 */
  isSidechain?: boolean       // 标记为子 Agent 会话
  agentId?: string            // 子 Agent 唯一 ID
  parentSessionId?: string    // 父会话 ID（关联追踪）

  /** compact 事件 */
  compactSummary?: string          // 压缩摘要文本
  compactedMessageCount?: number   // 被压缩的消息数
  tokensBefore?: number            // 压缩前 token 数
  compactStrategy?: string         // 使用的策略名称

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

/** 工具执行记录（loadMessages 还原用） */
export interface SnapshotToolEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  durationMs?: number
  success?: boolean
  resultSummary?: string
}

export interface SessionSnapshot {
  sessionId: string
  provider: string
  model: string
  cwd: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    toolEvents?: SnapshotToolEvent[]
    /** assistant 消息的模型名（中途可能切换） */
    model?: string
    /** assistant 消息的供应商名 */
    provider?: string
    /** assistant 消息本轮累计 token 用量 */
    usage?: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
    /** LLM 停止原因 */
    stopReason?: string
    /** 本轮 LLM 调用次数 */
    llmCallCount?: number
    /** 本轮工具调用次数 */
    toolCallCount?: number
    /** 思考过程 */
    thinking?: string
  }>
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

/** SubAgent JSONL 回放后的快照（Web session_init 用） */
export interface SubagentSnapshot {
  agentId: string
  description: string
  status: 'running' | 'done' | 'error'
  events: SubagentSnapshotEvent[]
}

/** SubAgent 事件详情 */
export type SubagentSnapshotEvent =
  | { kind: 'tool_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> }
  | { kind: 'tool_done'; toolName: string; toolCallId: string; durationMs?: number; success?: boolean; resultSummary?: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string }

export interface SessionSummary {
  sessionId: string
  projectSlug: string
  firstMessage: string
  updatedAt: string
  gitBranch: string
  fileSize: number
  filePath: string
}

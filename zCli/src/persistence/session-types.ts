// src/persistence/session-types.ts

import type { TokenUsage, MessageContent } from '@core/types.js'

export type SessionEventType =
  | 'session_start'
  | 'session_resume'
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool_call'
  | 'tool_result'
  | 'turn_duration'

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
}

export interface SessionSnapshot {
  sessionId: string
  provider: string
  model: string
  cwd: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
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

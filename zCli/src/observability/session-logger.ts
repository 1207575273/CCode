// src/observability/session-logger.ts

/**
 * SessionLogger — 事件流观察者，将 AgentEvent 转换为 SessionEvent 写入 JSONL。
 *
 * 职责：
 * - 订阅 AgentEvent 流，按类型映射为 SessionEvent
 * - 维护 parentUuid 链条（事件树）
 * - 累计 TurnStats 用于 session_end 汇总
 * - 记录 MCP 连接事件（通过 logMcpConnect 回调）
 * - 静默处理持久化错误，不阻断主流程
 */

import type { SessionStore } from '@persistence/session-store.js'
import { sessionStore as defaultStore, generateEventId } from '@persistence/index.js'
import type { SessionEvent, SessionEventType } from '@persistence/session-types.js'
import type { AgentEvent } from '@core/agent-loop.js'
import type { McpConnectEvent } from '@mcp/mcp-manager.js'

interface TurnStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalToolCalls: number
  totalLlmCalls: number
  totalErrors: number
  startTime: number
}

export class SessionLogger {
  #sessionId: string | null = null
  #lastEventUuid: string | null = null
  #turnStats: TurnStats = SessionLogger.#emptyStats()
  #cwd: string = process.cwd()
  readonly #store: SessionStore

  constructor(store?: SessionStore) {
    this.#store = store ?? defaultStore
  }

  /** 绑定到一个已有会话（恢复/分叉时调用） */
  bind(sessionId: string, lastEventUuid?: string | null): void {
    this.#sessionId = sessionId
    this.#lastEventUuid = lastEventUuid ?? null
  }

  /** 获取当前 sessionId */
  get sessionId(): string | null {
    return this.#sessionId
  }

  /** 获取最新事件 UUID（供 parentUuid 链接） */
  get lastEventUuid(): string | null {
    return this.#lastEventUuid
  }

  /** 消费一个 AgentEvent，映射为 SessionEvent 写入 JSONL */
  consume(event: AgentEvent): void {
    if (!this.#sessionId) return

    switch (event.type) {
      case 'llm_start':
        this.#turnStats.totalLlmCalls++
        this.#appendEvent('llm_call_start', {
          provider: event.provider,
          model: event.model,
          messageCount: event.messageCount,
        })
        break

      case 'llm_usage':
        this.#turnStats.totalInputTokens += event.inputTokens
        this.#turnStats.totalOutputTokens += event.outputTokens
        this.#turnStats.totalCacheReadTokens += event.cacheReadTokens
        this.#turnStats.totalCacheWriteTokens += event.cacheWriteTokens
        this.#appendEvent('llm_call_end', {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          stopReason: event.stopReason,
        })
        break

      case 'llm_error':
        this.#turnStats.totalErrors++
        this.#appendEvent('llm_call_end', {
          outputTokens: event.partialOutputTokens ?? 0,
          stopReason: 'error',
          error: event.error,
        })
        break

      case 'tool_start':
        this.#turnStats.totalToolCalls++
        this.#appendEvent('tool_call_start', {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
        })
        break

      case 'tool_done':
        this.#appendEvent('tool_call_end', {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          durationMs: event.durationMs,
          success: event.success,
          ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
        })
        break

      case 'tool_fallback':
        this.#appendEvent('tool_fallback', {
          toolName: event.toolName,
          fromLevel: event.fromLevel,
          toLevel: event.toLevel,
          reason: event.reason,
        })
        break

      case 'permission_grant':
        this.#appendEvent('permission_grant', {
          toolName: event.toolName,
          always: event.always,
        })
        break

      case 'error':
        this.#turnStats.totalErrors++
        this.#appendEvent('error', {
          error: event.error,
          source: 'agent',
        })
        break

      // text, done, permission_request 不写日志
      default:
        break
    }
  }

  /** 记录用户消息 */
  logUserMessage(content: string): void {
    this.#appendEvent('user', {
      message: { role: 'user', content },
    })
  }

  /** 记录助手回复 */
  logAssistantMessage(content: string, model?: string): void {
    this.#appendEvent('assistant', {
      message: model
        ? { role: 'assistant', content, model }
        : { role: 'assistant', content },
    })
  }

  /** 记录 MCP 连接事件（McpManager.onConnect 回调） */
  logMcpConnect(event: McpConnectEvent): void {
    if (!this.#sessionId) return
    const type: SessionEventType = event.phase === 'start' ? 'mcp_connect_start' : 'mcp_connect_end'
    const fields: Partial<SessionEvent> = {
      serverName: event.serverName,
      transport: event.transport,
    }
    if (event.success !== undefined) fields.success = event.success
    if (event.toolCount !== undefined) fields.toolCount = event.toolCount
    if (event.durationMs !== undefined) fields.durationMs = event.durationMs
    if (event.error !== undefined) fields.error = event.error
    this.#appendEvent(type, fields)
  }

  /** 创建新会话（惰性，首次 submit 时调用） */
  ensureSession(provider: string, model: string): string {
    if (this.#sessionId) return this.#sessionId
    try {
      const id = this.#store.create(this.#cwd, provider, model)
      this.#sessionId = id
      this.#turnStats = SessionLogger.#emptyStats()
      // store.create 写入了 session_start 事件，需要获取其 uuid 作为 parentUuid 链起点
      // 通过 loadMessages 取 leafEventUuid（此时 JSONL 只有一条 session_start）
      try {
        const snapshot = this.#store.loadMessages(id)
        this.#lastEventUuid = snapshot.leafEventUuid
      } catch {
        this.#lastEventUuid = null
      }
      return id
    } catch {
      return ''
    }
  }

  /** 写入 session_end 汇总事件 */
  finalize(): void {
    if (!this.#sessionId) return
    const durationMs = Date.now() - this.#turnStats.startTime
    this.#appendEvent('session_end', {
      totalInputTokens: this.#turnStats.totalInputTokens,
      totalOutputTokens: this.#turnStats.totalOutputTokens,
      totalCacheReadTokens: this.#turnStats.totalCacheReadTokens,
      totalCacheWriteTokens: this.#turnStats.totalCacheWriteTokens,
      totalToolCalls: this.#turnStats.totalToolCalls,
      totalLlmCalls: this.#turnStats.totalLlmCalls,
      totalErrors: this.#turnStats.totalErrors,
      totalDurationMs: durationMs,
    })
  }

  /** 追加事件到 JSONL，静默处理错误 */
  #appendEvent(type: SessionEventType, fields: Partial<SessionEvent> = {}): void {
    if (!this.#sessionId) return
    try {
      const eventId = generateEventId()
      const event: SessionEvent = {
        sessionId: this.#sessionId,
        type,
        timestamp: new Date().toISOString(),
        uuid: eventId,
        parentUuid: this.#lastEventUuid,
        cwd: this.#cwd,
        ...fields,
      }
      this.#store.append(this.#sessionId, event)
      this.#lastEventUuid = eventId
    } catch {
      // 持久化失败不阻断主流程
    }
  }

  static #emptyStats(): TurnStats {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalToolCalls: 0,
      totalLlmCalls: 0,
      totalErrors: 0,
      startTime: Date.now(),
    }
  }
}

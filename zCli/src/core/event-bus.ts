// src/core/event-bus.ts

import type { AgentEvent } from './agent-loop.js'

/** Bridge 层扩展事件 */
export type BridgeEvent =
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'permission_response'; allow: boolean; source: 'cli' | 'web' }
  | { type: 'question_response'; cancelled: boolean; answers?: Record<string, string | string[]>; source: 'cli' | 'web' }
  | { type: 'config_changed'; provider: string; model: string }
  | { type: 'client_connect'; clientId: string; clientType: 'cli' | 'web' }
  | { type: 'client_disconnect'; clientId: string }
  | { type: 'todo_update'; todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'subagent_progress'; agentId: string; description: string; turn: number; maxTurns: number; currentTool?: string }
  | { type: 'subagent_done'; agentId: string; description: string; success: boolean; output: string }
  | { type: 'subagent_event'; agentId: string; detail: SubAgentDetail }
  | { type: 'context_update'; usedPercentage: number; lastInputTokens: number; effectiveWindow: number; level: string }
  | { type: 'compact_status'; status: 'start' | 'done' | 'error'; strategy?: string; message?: string }

/** SubAgent 详细事件（透传到 Web 端展示） */
export type SubAgentDetail =
  | { kind: 'tool_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> }
  | { kind: 'tool_done'; toolName: string; toolCallId: string; durationMs?: number; success?: boolean; resultSummary?: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string }

/** EventBus 传输的所有事件类型 */
export type BusEvent = AgentEvent | BridgeEvent

/** 已连接客户端信息 */
interface ConnectedClient {
  clientId: string
  clientType: 'cli' | 'web'
}

type Handler = (event: BusEvent) => void

/**
 * 进程内事件总线 — CLI 和 Web 的双向广播中枢。
 *
 * - AgentLoop 产出的 AgentEvent → 广播到 CLI (Ink) + Web (WebSocket)
 * - Web 端用户输入 → 路由回 useChat.submit()
 * - 单例使用，CLI 进程生命周期内存在
 */
export class EventBus {
  readonly #handlers = new Set<Handler>()
  readonly #clients: ConnectedClient[] = []

  /** 订阅所有事件，返回取消订阅函数 */
  on(handler: Handler): () => void {
    this.#handlers.add(handler)
    return () => { this.#handlers.delete(handler) }
  }

  /** 订阅特定类型的事件 */
  onType<T extends BusEvent['type']>(
    type: T,
    handler: (event: Extract<BusEvent, { type: T }>) => void,
  ): () => void {
    return this.on((event) => {
      if (event.type === type) {
        handler(event as Extract<BusEvent, { type: T }>)
      }
    })
  }

  /** 发布事件（同步广播给所有订阅者） */
  emit(event: BusEvent): void {
    // 维护客户端列表
    if (event.type === 'client_connect') {
      this.#clients.push({ clientId: event.clientId, clientType: event.clientType })
    } else if (event.type === 'client_disconnect') {
      const idx = this.#clients.findIndex(c => c.clientId === event.clientId)
      if (idx !== -1) this.#clients.splice(idx, 1)
    }

    for (const handler of this.#handlers) {
      try {
        handler(event)
      } catch {
        // 单个 handler 异常不影响其他订阅者
      }
    }
  }

  /** 获取当前已连接的客户端列表 */
  getClients(): readonly ConnectedClient[] {
    return this.#clients
  }
}

/** 全局单例 */
export const eventBus = new EventBus()

/** 将 AgentEvent 转为可 JSON 序列化的格式（去除回调函数） */
export function toSerializableEvent(event: AgentEvent): Record<string, unknown> | null {
  if (event.type === 'permission_request') {
    return { type: 'permission_request', toolName: event.toolName, args: event.args }
  }
  if (event.type === 'user_question_request') {
    return { type: 'user_question_request', questions: event.questions }
  }
  return event as Record<string, unknown>
}

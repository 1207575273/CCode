// src/server/bridge/client.ts

/**
 * BridgeClient — CLI 端 WebSocket 客户端。
 *
 * 连接到 Bridge Server，注册 sessionId，
 * 推送 AgentEvent 给 Web 端，接收 Web 端输入转发到本地 EventBus。
 *
 * 所有 CLI 实例（包括启动 Bridge Server 的那个）都通过此客户端连接，
 * 地位完全平等。
 */

import { WebSocket } from 'ws'
import { eventBus, toSerializableEvent } from '@core/event-bus.js'
import type { AgentEvent } from '@core/agent-loop.js'

const RECONNECT_INTERVAL_MS = 2000

/** Bridge 连接状态 */
let ws: WebSocket | null = null
let sessionId: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

/** 是否已连接到 Bridge Server */
export function isBridgeConnected(): boolean {
  return ws != null && ws.readyState === WebSocket.OPEN
}

/**
 * 连接到 Bridge Server 并注册 session。
 * 连接后：
 * 1. 发送 register 消息声明 cli 身份和 sessionId
 * 2. 订阅本地 EventBus，将 AgentEvent 推送给 Bridge
 * 3. 接收 Bridge 转发的 Web 端输入，发布到本地 EventBus
 */
export function connectBridge(port: number, sid: string): void {
  sessionId = sid
  doConnect(port)
}

/**
 * 更新 Bridge 注册的 sessionId（resume 场景）。
 * 发送新的 register 消息让 Bridge 更新客户端关联的 session。
 */
export function updateBridgeSession(newSid: string): void {
  sessionId = newSid
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'register',
      clientType: 'cli',
      sessionId: newSid,
    }))
  }
}

/** 断开连接（CLI 退出时调用） */
export function disconnectBridge(): void {
  clearTimeout(reconnectTimer)
  if (ws) {
    ws.close()
    ws = null
  }
}

function doConnect(port: number): void {
  const socket = new WebSocket(`ws://localhost:${port}/ws`)

  socket.on('open', () => {
    ws = socket
    // 注册身份
    socket.send(JSON.stringify({
      type: 'register',
      clientType: 'cli',
      sessionId,
    }))
  })

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data)) as { type: string; [key: string]: unknown }
      handleBridgeMessage(msg)
    } catch {
      // 无效 JSON
    }
  })

  socket.on('close', () => {
    ws = null
    // 自动重连
    reconnectTimer = setTimeout(() => doConnect(port), RECONNECT_INTERVAL_MS)
  })

  socket.on('error', () => {
    socket.close()
  })
}

/** 处理从 Bridge Server 收到的消息（Web 端输入转发） */
function handleBridgeMessage(msg: { type: string; [key: string]: unknown }): void {
  switch (msg.type) {
    case 'chat':
      eventBus.emit({
        type: 'user_input',
        text: String(msg['text'] ?? ''),
        source: 'web',
      })
      break
    case 'permission':
      eventBus.emit({
        type: 'permission_response',
        allow: Boolean(msg['allow']),
        always: Boolean(msg['always']),
        source: 'web',
      })
      break
    case 'abort':
      eventBus.emit({ type: 'user_input', text: '__abort__', source: 'web' })
      break
    case 'question': {
      const cancelled = Boolean(msg['cancelled'])
      const answers = msg['answers'] as Record<string, string | string[]> | undefined
      eventBus.emit({
        type: 'question_response',
        cancelled,
        ...(answers ? { answers } : {}),
        source: 'web',
      })
      break
    }
    case 'config_changed':
      eventBus.emit({
        type: 'config_changed',
        provider: String(msg['provider'] ?? ''),
        model: String(msg['model'] ?? ''),
      })
      break
    case 'bridge_stop':
      // Bridge 关闭，断开连接不重连
      clearTimeout(reconnectTimer)
      ws?.close()
      ws = null
      break
  }
}

// ── 订阅本地 EventBus，推送 AgentEvent 到 Bridge ──

/** 不需要推送给 Bridge 的事件类型 */
const SKIP_TYPES = new Set([
  'client_connect', 'client_disconnect',
  'permission_response', 'question_response',
])

eventBus.on((event) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  // 内部管理事件不推送
  if (SKIP_TYPES.has(event.type)) return
  // Web 端回流的 user_input 不再推回 Bridge（防止循环）
  if (event.type === 'user_input' && event.source === 'web') return

  // AgentEvent 需要序列化（去除回调函数）
  const isAgent = !event.type.startsWith('user_input') &&
    !['permission_response', 'question_response', 'client_connect', 'client_disconnect'].includes(event.type)

  const payload = isAgent ? toSerializableEvent(event as AgentEvent) : event
  if (!payload) return

  ws.send(JSON.stringify({ type: 'event', payload }))
})

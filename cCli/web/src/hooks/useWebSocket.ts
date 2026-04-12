// src/hooks/useWebSocket.ts

/**
 * WebSocket 连接管理 Hook。
 *
 * 用 onEvent callback + useRef 处理事件流（不丢事件）。
 * 防止 React StrictMode 下重复连接导致事件翻倍。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ServerEvent, ClientMessage } from '../types'

interface UseWebSocketOptions {
  sessionId?: string | null
  onEvent?: (event: ServerEvent) => void
}

interface UseWebSocketReturn {
  connected: boolean
  send: (msg: ClientMessage) => void
}

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`
const RECONNECT_INTERVAL_MS = 2000

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { sessionId, onEvent } = options
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const connect = useCallback(() => {
    // 关闭已有连接（防止 StrictMode 重复连接）
    if (wsRef.current) {
      wsRef.current.onclose = null // 移除 onclose 防止触发重连
      wsRef.current.close()
      wsRef.current = null
    }
    clearTimeout(reconnectTimer.current)

    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({
        type: 'register',
        clientType: 'web',
        sessionId: sessionId ?? '',
      }))
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ServerEvent
        onEventRef.current?.(event)
      } catch (err) {
        console.warn('[WebSocket] 消息 JSON 解析失败:', err)
      }
    }

    ws.onclose = () => {
      // 只有当前活跃的连接断开才重连（防止 StrictMode 的旧连接触发重连）
      if (wsRef.current === ws) {
        setConnected(false)
        wsRef.current = null
        reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL_MS)
      }
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [sessionId])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      if (wsRef.current) {
        wsRef.current.onclose = null // cleanup 时不触发重连
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, send }
}

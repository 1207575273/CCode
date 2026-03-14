// src/hooks/useWebSocket.ts

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ServerEvent, ClientMessage } from '../types.js'

interface UseWebSocketReturn {
  connected: boolean
  lastEvent: ServerEvent | null
  send: (msg: ClientMessage) => void
}

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`
const RECONNECT_INTERVAL_MS = 2000

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      setConnected(true)
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ServerEvent
        setLastEvent(event)
      } catch {
        // 无效 JSON，静默忽略
      }
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL_MS)
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, lastEvent, send }
}

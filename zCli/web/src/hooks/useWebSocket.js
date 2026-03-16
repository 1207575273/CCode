// src/hooks/useWebSocket.ts
import { useState, useEffect, useRef, useCallback } from 'react';
const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;
const RECONNECT_INTERVAL_MS = 2000;
export function useWebSocket(options = {}) {
    const { sessionId } = options;
    const [connected, setConnected] = useState(false);
    const [lastEvent, setLastEvent] = useState(null);
    const wsRef = useRef(null);
    const reconnectTimer = useRef(undefined);
    const connect = useCallback(() => {
        const ws = new WebSocket(WS_URL);
        ws.onopen = () => {
            setConnected(true);
            // 连接后发送 register 消息，声明 web 身份和 sessionId
            ws.send(JSON.stringify({
                type: 'register',
                clientType: 'web',
                sessionId: sessionId ?? '',
            }));
        };
        ws.onmessage = (e) => {
            try {
                const event = JSON.parse(e.data);
                setLastEvent(event);
            }
            catch {
                // 无效 JSON，静默忽略
            }
        };
        ws.onclose = () => {
            setConnected(false);
            wsRef.current = null;
            reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
        };
        ws.onerror = () => {
            ws.close();
        };
        wsRef.current = ws;
    }, [sessionId]);
    useEffect(() => {
        connect();
        return () => {
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
        };
    }, [connect]);
    const send = useCallback((msg) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
        }
    }, []);
    return { connected, lastEvent, send };
}

// src/pages/ChatPage.tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket.js'
import { MessageBubble } from '../components/MessageBubble.js'
import { InputBar } from '../components/InputBar.js'
import { ToolStatus } from '../components/ToolStatus.js'
import { PermissionCard } from '../components/PermissionCard.js'
import type { ChatMessage, ToolEvent, ServerEvent } from '../types.js'

export function ChatPage() {
  const { connected, lastEvent, send } = useWebSocket()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; args: Record<string, unknown> } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const msgIdCounter = useRef(0)

  useEffect(() => {
    if (!lastEvent) return
    handleServerEvent(lastEvent)
  }, [lastEvent])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  // 处理服务端事件，根据事件类型更新 UI 状态
  function handleServerEvent(event: ServerEvent) {
    switch (event.type) {
      case 'user_input': {
        const msg: ChatMessage = {
          id: `msg-${++msgIdCounter.current}`,
          role: 'user',
          content: event.text,
          source: event.source,
        }
        setMessages(prev => [...prev, msg])
        setStreaming('')
        setIsStreaming(true)
        break
      }
      case 'text':
        // 流式追加文本
        setStreaming(prev => prev + event.text)
        break
      case 'tool_start':
        setToolEvents(prev => [...prev, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: 'running',
        }])
        break
      case 'tool_done':
        setToolEvents(prev => prev.map(e =>
          e.toolCallId === event.toolCallId
            ? { ...e, status: 'done' as const, durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary }
            : e
        ))
        break
      case 'permission_request':
        setPendingPermission({ toolName: event.toolName, args: event.args })
        break
      case 'done': {
        // 将流式内容固化为消息气泡
        setStreaming(prev => {
          if (prev) {
            const assistantMsg: ChatMessage = {
              id: `msg-${++msgIdCounter.current}`,
              role: 'assistant',
              content: prev,
            }
            setMessages(msgs => [...msgs, assistantMsg])
          }
          return ''
        })
        setIsStreaming(false)
        setToolEvents([])
        setPendingPermission(null)
        break
      }
      case 'error':
        setStreaming('')
        setIsStreaming(false)
        setMessages(prev => [...prev, {
          id: `msg-${++msgIdCounter.current}`,
          role: 'system',
          content: `错误: ${event.error}`,
        }])
        break
      // llm_start / llm_usage 暂不渲染
      default:
        break
    }
  }

  const handleSubmit = useCallback((text: string) => {
    send({ type: 'chat', text })
  }, [send])

  const handlePermission = useCallback((allow: boolean) => {
    send({ type: 'permission', allow })
    setPendingPermission(null)
  }, [send])

  // isStreaming 用于禁用输入框，避免多轮并发
  const inputDisabled = !connected || isStreaming

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h1 className="text-lg font-semibold">ZCli Dashboard</h1>
        <span className={`text-xs px-2 py-1 rounded ${connected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          {connected ? '已连接' : '断开'}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {streaming && (
          <MessageBubble message={{ id: 'streaming', role: 'assistant', content: streaming }} />
        )}
        <ToolStatus events={toolEvents} />
        {pendingPermission && (
          <PermissionCard
            toolName={pendingPermission.toolName}
            args={pendingPermission.args}
            onAllow={() => handlePermission(true)}
            onDeny={() => handlePermission(false)}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <InputBar onSubmit={handleSubmit} disabled={inputDisabled} />
    </div>
  )
}

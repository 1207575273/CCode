// src/pages/ChatPage.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket.js'
import { MessageBubble } from '../components/MessageBubble.js'
import { InputBar } from '../components/InputBar.js'
import { ToolStatus } from '../components/ToolStatus.js'
import { PermissionCard } from '../components/PermissionCard.js'
import { UserQuestionForm } from '../components/UserQuestionForm.js'
import type { ChatMessage, ToolEvent, ServerEvent, UserQuestion } from '../types.js'

interface ChatPageProps {
  /** URL 路由中的 sessionId，为 null 时连接当前活跃 session */
  targetSessionId?: string | null
}

export function ChatPage({ targetSessionId }: ChatPageProps) {
  const { connected, lastEvent, send } = useWebSocket()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionModel, setSessionModel] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; args: Record<string, unknown> } | null>(null)
  const [pendingQuestions, setPendingQuestions] = useState<UserQuestion[] | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const msgIdCounter = useRef(0)

  useEffect(() => {
    if (!lastEvent) return
    handleServerEvent(lastEvent)
  }, [lastEvent])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming, toolEvents])

  function handleServerEvent(event: ServerEvent) {
    switch (event.type) {
      case 'session_init': {
        // 连接时收到：sessionId + JSONL 历史消息还原
        setSessionId(event.sessionId)
        if (event.model) setSessionModel(event.model)
        // URL 同步：如果当前路径不含 sessionId，更新 URL（不触发页面刷新）
        if (!targetSessionId && event.sessionId) {
          window.history.replaceState(null, '', `/session/${event.sessionId}`)
        }
        // 还原历史消息
        const restored: ChatMessage[] = event.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
        }))
        setMessages(restored)
        msgIdCounter.current = restored.length
        break
      }
      case 'user_input': {
        // CLI 端的输入同步到 Web 显示
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
      case 'user_question_request':
        setPendingQuestions(event.questions)
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
        // 将已完成的工具事件写入消息历史（保留展示）
        setToolEvents(prev => {
          if (prev.length > 0) {
            const summary = prev.map(e => {
              const status = e.success ? '✓' : e.success === false ? '✗' : '?'
              const dur = e.durationMs != null ? ` (${e.durationMs}ms)` : ''
              const result = e.resultSummary ? `\n  ⎿ ${e.resultSummary}` : ''
              return `${status} ${e.toolName}${dur}${result}`
            }).join('\n')
            setMessages(msgs => [...msgs, {
              id: `msg-${++msgIdCounter.current}`,
              role: 'system',
              content: summary,
            }])
          }
          return []
        })
        setIsStreaming(false)
        setPendingPermission(null)
        setPendingQuestions(null)
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
      default:
        break
    }
  }

  const handleSubmit = useCallback((text: string) => {
    // 流式中发新消息 → 先中止当前回复，再提交（与 CLI interruptAndSubmit 行为一致）
    if (isStreaming) {
      // 将已有流式内容固化为部分回复
      setStreaming(prev => {
        if (prev) {
          setMessages(msgs => [...msgs, {
            id: `msg-${++msgIdCounter.current}`,
            role: 'assistant' as const,
            content: prev + '\n\n*(已中断)*',
          }])
        }
        return ''
      })
      setToolEvents([])
      setPendingPermission(null)
      setPendingQuestions(null)
      send({ type: 'abort' })
    }

    setMessages(prev => [...prev, {
      id: `msg-${++msgIdCounter.current}`,
      role: 'user' as const,
      content: text,
      source: 'web' as const,
    }])
    setStreaming('')
    setIsStreaming(true)
    // 短暂延迟让 abort 先到达 CLI，再发新消息
    setTimeout(() => send({ type: 'chat', text }), 50)
  }, [send, isStreaming])

  const handlePermission = useCallback((allow: boolean) => {
    send({ type: 'permission', allow })
    setPendingPermission(null)
  }, [send])

  const handleQuestionSubmit = useCallback((answers: Record<string, string | string[]>) => {
    send({ type: 'question', cancelled: false, answers })
    setPendingQuestions(null)
  }, [send])

  const handleQuestionCancel = useCallback(() => {
    send({ type: 'question', cancelled: true })
    setPendingQuestions(null)
  }, [send])

  const inputDisabled = !connected

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">ZCli</h1>
          {sessionModel && <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">{sessionModel}</span>}
          {sessionId && <span className="text-xs text-gray-500 font-mono">{sessionId.slice(0, 8)}</span>}
        </div>
        <span className={`text-xs px-2 py-1 rounded ${connected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          {connected ? '已连接' : '断开'}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* 流式输出 */}
        {streaming && (
          <MessageBubble message={{ id: 'streaming', role: 'assistant', content: streaming }} />
        )}

        {/* 工具执行进度（实时） */}
        <ToolStatus events={toolEvents} />

        {/* 权限确认 */}
        {pendingPermission && (
          <PermissionCard
            toolName={pendingPermission.toolName}
            args={pendingPermission.args}
            onAllow={() => handlePermission(true)}
            onDeny={() => handlePermission(false)}
          />
        )}

        {/* 用户问卷 */}
        {pendingQuestions && (
          <UserQuestionForm
            questions={pendingQuestions}
            onSubmit={handleQuestionSubmit}
            onCancel={handleQuestionCancel}
          />
        )}

        <div ref={bottomRef} />
      </div>

      <InputBar onSubmit={handleSubmit} disabled={inputDisabled} />
    </div>
  )
}

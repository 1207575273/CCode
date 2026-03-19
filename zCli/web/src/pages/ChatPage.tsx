// src/pages/ChatPage.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { MessageBubble } from '../components/MessageBubble'
import { InputBar } from '../components/InputBar'
import { ToolStatus } from '../components/ToolStatus'
import { PermissionCard } from '../components/PermissionCard'
import { UserQuestionForm } from '../components/UserQuestionForm'
import { TodoPanel } from '../components/TodoPanel'
import type { SubAgentInfo, SubAgentDetailEvent } from '../components/SubAgentCard'
import type { ChatMessage, ToolEvent, ServerEvent, UserQuestion } from '../types'

interface ChatPageProps {
  targetSessionId?: string | null
}

export function ChatPage({ targetSessionId }: ChatPageProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; args: Record<string, unknown> } | null>(null)
  const [pendingQuestions, setPendingQuestions] = useState<UserQuestion[] | null>(null)
  const [todos, setTodos] = useState<Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>>([])
  const [subAgents, setSubAgents] = useState<Map<string, SubAgentInfo>>(new Map())
  /** CLI 是否在线（对应当前 session 有活跃的 CLI 连接） */
  const [cliConnected, setCliConnected] = useState(true)
  /** 当前活跃的 CLI session（不同于本页 session 时显示切换提示） */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  /** 上下文窗口使用率 */
  const [contextInfo, setContextInfo] = useState<{ usedPercentage: number; level: string } | null>(null)
  /** compact 状态 */
  const [compacting, setCompacting] = useState<{ strategy: string; message: string } | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const msgIdCounter = useRef(0)
  const turnTextRef = useRef('')
  const turnToolsRef = useRef<ToolEvent[]>([])

  const { connected, send } = useWebSocket({
    sessionId: targetSessionId,
    onEvent: handleServerEvent,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming, toolEvents])

  /** 生成递增消息 ID */
  function nextId(): string {
    return `msg-${++msgIdCounter.current}`
  }

  /** 重置本轮状态 */
  function resetTurn(): void {
    setStreaming('')
    setToolEvents([])
    setIsStreaming(false)
    setPendingPermission(null)
    setPendingQuestions(null)
    turnTextRef.current = ''
    turnToolsRef.current = []
  }

  function handleServerEvent(event: ServerEvent) {
    console.log('[WS Event]', event.type, event.type === 'text' ? `(+${(event as {text:string}).text.length} chars)` : '', event)

    switch (event.type) {
      case 'session_init': {
        setSessionId(event.sessionId)
        setCliConnected(event.cliConnected !== false)
        setActiveSessionId(event.activeSessionId ?? null)
        // model 信息现在由每条 assistant 消息携带，不需要 session 级别的
        if (!targetSessionId && event.sessionId) {
          window.history.replaceState(null, '', `/session/${event.sessionId}`)
        }
        setMessages(event.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ...(m.toolEvents && m.toolEvents.length > 0 ? { toolEvents: m.toolEvents } : {}),
          ...(m.model ? { model: m.model } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(m.usage ? { usage: m.usage } : {}),
          ...(m.llmCallCount ? { llmCallCount: m.llmCallCount } : {}),
          ...(m.toolCallCount ? { toolCallCount: m.toolCallCount } : {}),
        })))
        msgIdCounter.current = event.messages.length

        // 恢复 SubAgent 数据（从 JSONL 回放）
        if (event.subagents && event.subagents.length > 0) {
          const restored = new Map<string, SubAgentInfo>()
          for (const sa of event.subagents) {
            restored.set(sa.agentId, {
              agentId: sa.agentId,
              description: sa.description,
              status: sa.status,
              turn: 0,
              maxTurns: 25,
              events: sa.events.map(e => {
                const detail: SubAgentDetailEvent = { type: e.kind }
                if (e.kind === 'tool_start' || e.kind === 'tool_done') {
                  detail.toolName = e.toolName
                }
                if (e.kind === 'tool_done') {
                  detail.durationMs = e.durationMs
                  detail.success = e.success
                  detail.resultSummary = e.resultSummary
                }
                if (e.kind === 'text') {
                  detail.text = e.text
                }
                if (e.kind === 'error') {
                  detail.error = e.error
                }
                return detail
              }),
            })
          }
          setSubAgents(restored)
        }
        break
      }
      case 'user_input':
        setMessages(prev => [...prev, { id: nextId(), role: 'user', content: event.text, source: event.source }])
        setStreaming('')
        setIsStreaming(true)
        turnTextRef.current = ''
        turnToolsRef.current = []
        break
      case 'text':
        turnTextRef.current += event.text
        setStreaming(prev => prev + event.text)
        break
      case 'tool_start':
        setStreaming('')
        setToolEvents(prev => [...prev, {
          toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, status: 'running',
        }])
        break
      case 'tool_done': {
        const completed: ToolEvent = {
          toolCallId: event.toolCallId, toolName: event.toolName, args: {},
          status: 'done', durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary,
        }
        setToolEvents(prev => {
          const running = prev.find(e => e.toolCallId === event.toolCallId)
          if (running) completed.args = running.args
          turnToolsRef.current.push(completed)
          return prev.map(e => e.toolCallId === event.toolCallId
            ? { ...e, status: 'done' as const, durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary }
            : e)
        })
        break
      }
      case 'permission_request':
        setPendingPermission({ toolName: event.toolName, args: event.args })
        break
      case 'user_question_request':
        setPendingQuestions(event.questions)
        break
      case 'done': {
        const finalText = turnTextRef.current
        const finalTools = [...turnToolsRef.current]
        const newMsgs: ChatMessage[] = []
        if (finalTools.length > 0) {
          newMsgs.push({ id: nextId(), role: 'system', content: '', toolEvents: finalTools })
        }
        if (finalText) {
          newMsgs.push({ id: nextId(), role: 'assistant', content: finalText })
        }
        resetTurn()
        if (newMsgs.length > 0) {
          setMessages(prev => [...prev, ...newMsgs])
        }
        break
      }
      case 'todo_update':
        setTodos(event.todos)
        break
      case 'subagent_progress':
        setSubAgents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.agentId)
          next.set(event.agentId, {
            agentId: event.agentId,
            description: event.description,
            status: 'running',
            turn: event.turn,
            maxTurns: event.maxTurns,
            currentTool: event.currentTool,
            events: existing?.events ?? [],
          })
          return next
        })
        break
      case 'subagent_done':
        setSubAgents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.agentId)
          if (existing) {
            next.set(event.agentId, {
              ...existing,
              status: event.success ? 'done' : 'error',
              currentTool: undefined,
            })
          }
          return next
        })
        break
      case 'subagent_event':
        setSubAgents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.agentId)
          if (existing) {
            const d = event.detail
            const newEvent: SubAgentDetailEvent = { type: d.kind }
            if (d.kind === 'tool_start' || d.kind === 'tool_done') {
              newEvent.toolName = d.toolName
            }
            if (d.kind === 'tool_done') {
              newEvent.durationMs = d.durationMs
              newEvent.success = d.success
              newEvent.resultSummary = d.resultSummary
            }
            if (d.kind === 'text') {
              newEvent.text = d.text
            }
            if (d.kind === 'error') {
              newEvent.error = d.error
            }
            next.set(event.agentId, {
              ...existing,
              events: [...existing.events, newEvent],
            })
          }
          return next
        })
        break
      case 'cli_status':
        setCliConnected(event.connected)
        break
      case 'context_update':
        setContextInfo({ usedPercentage: event.usedPercentage, level: event.level })
        break
      case 'compact_status':
        if (event.status === 'start') {
          setCompacting({ strategy: event.strategy ?? 'unknown', message: event.message ?? 'Compacting...' })
        } else {
          setCompacting(null)
        }
        break
      case 'bridge_stop':
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: 'Bridge Server 已关闭' }])
        break
      case 'error':
        resetTurn()
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `错误: ${event.error}` }])
        break
    }
  }

  const handleSubmit = useCallback((text: string) => {
    // 流式中发新消息 → 先中止再提交
    if (isStreaming) {
      if (turnTextRef.current) {
        setMessages(prev => [...prev, { id: nextId(), role: 'assistant' as const, content: turnTextRef.current + '\n\n*(已中断)*' }])
      }
      resetTurn()
      send({ type: 'abort' })
    }
    setMessages(prev => [...prev, { id: nextId(), role: 'user' as const, content: text, source: 'web' as const }])
    setStreaming('')
    setIsStreaming(true)
    turnTextRef.current = ''
    turnToolsRef.current = []
    setTimeout(() => send({ type: 'chat', text }), 50)
  }, [send, isStreaming])

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">ZCli</h1>
          {sessionId && <span className="text-xs text-gray-500 font-mono">{sessionId.slice(0, 8)}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded ${connected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
            {connected ? '已连接' : 'Bridge 断开'}
          </span>
          {connected && !cliConnected && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-900 text-yellow-300">
              CLI 离线
            </span>
          )}
          {contextInfo && (
            <span className={`text-xs px-2 py-1 rounded ${
              contextInfo.level === 'overflow' || contextInfo.level === 'critical'
                ? 'bg-red-900 text-red-300'
                : contextInfo.level === 'warning'
                  ? 'bg-yellow-900 text-yellow-300'
                  : 'bg-gray-700 text-gray-400'
            }`}>
              Context: {(contextInfo.usedPercentage * 100).toFixed(0)}%
            </span>
          )}
          <button
            onClick={() => {
              if (window.confirm('确定关闭 Bridge Server？所有 Web 客户端将断开连接。')) {
                fetch('/api/bridge/stop', { method: 'POST' }).catch(() => {})
              }
            }}
            className="text-xs px-2 py-1 rounded bg-red-900/50 text-red-400 hover:bg-red-800 transition-colors"
            title="关闭 Bridge Server"
          >
            关闭 Bridge
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {/* CLI 离线提示 */}
        {connected && !cliConnected && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-yellow-900/30 border border-yellow-700/50 text-sm text-yellow-300 flex items-center justify-between">
            <span>⚠ 当前会话的 CLI 已离线，发送的消息不会被处理。</span>
            {activeSessionId && (
              <button
                onClick={() => {
                  window.location.href = `/session/${activeSessionId}`
                }}
                className="ml-3 px-2 py-1 rounded bg-yellow-700/50 hover:bg-yellow-600/50 text-yellow-200 text-xs transition-colors"
              >
                切换到活跃会话
              </button>
            )}
          </div>
        )}

        {/* 消息历史 */}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} subAgents={subAgents} />
        ))}

        {/* 流式输出：纯文本渲染（不走 ReactMarkdown，避免不完整 Markdown 渲染乱码） */}
        {streaming && (
          <div className="flex justify-start mb-3">
            <div className="max-w-[80%] rounded-lg px-4 py-3 bg-gray-800 text-gray-100">
              <p className="whitespace-pre-wrap text-sm">{streaming}</p>
            </div>
          </div>
        )}

        {/* Compact 进行中动效 */}
        {compacting && (
          <div className="flex justify-start mb-3">
            <div className="max-w-[80%] rounded-lg px-4 py-3 bg-gray-800 border border-blue-500/30">
              <div className="flex items-center gap-2 text-sm text-blue-300">
                <span className="animate-spin">⟳</span>
                <span>{compacting.message}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Strategy: <span className="text-blue-400">{compacting.strategy}</span>
              </div>
            </div>
          </div>
        )}

        {/* 工具执行进度（实时） */}
        <ToolStatus events={toolEvents} subAgents={subAgents} />

        {/* 任务计划面板 */}
        <TodoPanel todos={todos} />

        {/* 权限确认 */}
        {pendingPermission && (
          <PermissionCard toolName={pendingPermission.toolName} args={pendingPermission.args}
            onAllow={() => { send({ type: 'permission', allow: true }); setPendingPermission(null) }}
            onDeny={() => { send({ type: 'permission', allow: false }); setPendingPermission(null) }}
          />
        )}
        {/* 用户问卷 */}
        {pendingQuestions && (
          <UserQuestionForm questions={pendingQuestions}
            onSubmit={(answers) => { send({ type: 'question', cancelled: false, answers }); setPendingQuestions(null) }}
            onCancel={() => { send({ type: 'question', cancelled: true }); setPendingQuestions(null) }}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <InputBar onSubmit={handleSubmit} disabled={!connected || !!compacting} />
    </div>
  )
}

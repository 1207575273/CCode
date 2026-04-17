// src/pages/ChatPage.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { MessageBubble } from '../components/MessageBubble'
import { InputBar } from '../components/InputBar'
import { ToolStatus } from '../components/ToolStatus'
import { PermissionCard } from '../components/PermissionCard'
import { UserQuestionForm } from '../components/UserQuestionForm'
import { TodoPanel } from '../components/TodoPanel'
import { MemoryPanel } from '../components/MemoryPanel'
import { StatusBar } from '../components/StatusBar'
import type { StatusBarData } from '../components/StatusBar'
import type { SubAgentInfo, SubAgentDetailEvent } from '../components/SubAgentCard'
import { SubAgentDrawer } from '../components/SubAgentDrawer'
import type { ChatMessage, ToolEvent, ServerEvent, UserQuestion } from '../types'

interface ChatPageProps {
  targetSessionId?: string | null
}

export function ChatPage({ targetSessionId }: ChatPageProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [thinking, setThinking] = useState(false)
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
  /** compact 状态 */
  const [compacting, setCompacting] = useState<{ strategy: string; message: string } | null>(null)
  /** 记忆全景面板 */
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false)
  /** 状态栏数据（CLI 推送的系统/进程/token/上下文指标） */
  const [statusBarData, setStatusBarData] = useState<StatusBarData | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const msgIdCounter = useRef(0)
  const turnTextRef = useRef('')
  const turnToolsRef = useRef<ToolEvent[]>([])

  // 本地每秒更新 elapsed（基于服务端推送的基线值，让计时器平滑跳动而非等 3 秒推送）
  const statusBarBaseRef = useRef<{ elapsedMs: number; receivedAt: number } | null>(null)

  useEffect(() => {
    if (!statusBarData) return
    statusBarBaseRef.current = { elapsedMs: statusBarData.proc.elapsedMs, receivedAt: Date.now() }
  }, [statusBarData?.proc.elapsedMs])

  useEffect(() => {
    if (!statusBarData) return
    const id = setInterval(() => {
      const base = statusBarBaseRef.current
      if (!base) return
      const delta = Date.now() - base.receivedAt
      setStatusBarData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          proc: { ...prev.proc, elapsedMs: base.elapsedMs + delta },
        }
      })
    }, 1000)
    return () => clearInterval(id)
  // 仅在 statusBarData 从 null 变为非 null 时重建 interval
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusBarData !== null])

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
    setThinking(false)
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
        const restoredMsgs = event.messages.map(m => ({
          id: m.id,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
          ...(m.toolEvents && m.toolEvents.length > 0 ? { toolEvents: m.toolEvents } : {}),
          ...(m.model ? { model: m.model } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(m.usage ? { usage: m.usage } : {}),
          ...(m.llmCallCount ? { llmCallCount: m.llmCallCount } : {}),
          ...(m.toolCallCount ? { toolCallCount: m.toolCallCount } : {}),
        }))
        // 有历史消息时追加恢复提示，让用户明确感知会话已切换
        if (restoredMsgs.length > 0) {
          restoredMsgs.push({
            id: `resume-${Date.now()}`,
            role: 'system',
            content: `已恢复会话 ${event.sessionId.slice(0, 8)}...，${restoredMsgs.length} 条历史消息已加载`,
          })
        }
        setMessages(restoredMsgs)
        msgIdCounter.current = restoredMsgs.length

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
      case 'llm_start':
        // 每轮 LLM 调用开始时显示思考动效
        setThinking(true)
        setStreaming('')
        break
      case 'text':
        // 首次收到文字时关闭思考动效
        setThinking(false)
        if (turnTextRef.current === '') setStreaming('')
        turnTextRef.current += event.text
        setStreaming(prev => prev + event.text)
        break
      case 'tool_start':
        setThinking(false)
        setStreaming('')
        setToolEvents(prev => [...prev, {
          toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, status: 'running', startedAt: Date.now(),
        }])
        break
      case 'tool_done': {
        // 从 meta 中提取结构化 agentId（dispatch_agent 专用）
        const toolAgentId = event.meta?.type === 'dispatch-agent' ? event.meta.agentId : undefined
        const completed: ToolEvent = {
          toolCallId: event.toolCallId, toolName: event.toolName, args: {},
          status: 'done', durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary,
          ...(toolAgentId ? { agentId: toolAgentId } : {}),
        }
        setToolEvents(prev => {
          const running = prev.find(e => e.toolCallId === event.toolCallId)
          if (running) completed.args = running.args
          turnToolsRef.current.push(completed)
          return prev.map(e => e.toolCallId === event.toolCallId
            ? { ...e, status: 'done' as const, durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary, ...(toolAgentId ? { agentId: toolAgentId } : {}) }
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
            name: event.name,
            agentType: event.agentType,
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

            // 流式 text chunk 合并：连续的 text 事件追加到同一条，避免每个 chunk 独占一行
            if (d.kind === 'text') {
              const lastEvent = existing.events[existing.events.length - 1]
              if (lastEvent?.type === 'text') {
                const merged = [...existing.events]
                merged[merged.length - 1] = { ...lastEvent, text: (lastEvent.text ?? '') + (d.text ?? '') }
                next.set(event.agentId, { ...existing, events: merged })
              } else {
                next.set(event.agentId, {
                  ...existing,
                  events: [...existing.events, { type: 'text', text: d.text }],
                })
              }
            } else {
              const newEvent: SubAgentDetailEvent = { type: d.kind }
              if (d.kind === 'tool_start' || d.kind === 'tool_done') {
                newEvent.toolName = d.toolName
              }
              if (d.kind === 'tool_done') {
                newEvent.durationMs = d.durationMs
                newEvent.success = d.success
                newEvent.resultSummary = d.resultSummary
              }
              if (d.kind === 'error') {
                newEvent.error = d.error
              }
              next.set(event.agentId, {
                ...existing,
                events: [...existing.events, newEvent],
              })
            }
          }
          return next
        })
        break
      case 'cli_status':
        setCliConnected(event.connected)
        break
      case 'context_update':
        // context 信息已由 status_bar 事件统一推送到 StatusBar 组件展示
        break
      case 'compact_status':
        if (event.status === 'start') {
          setCompacting({ strategy: event.strategy ?? 'unknown', message: event.message ?? 'Compacting...' })
        } else {
          setCompacting(null)
        }
        break
      case 'status_bar':
        setStatusBarData(event.data)
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

  const handleSubmit = useCallback((text: string, imageIds?: string[]) => {
    // 流式中发新消息 → 先中止再提交
    if (isStreaming) {
      if (turnTextRef.current) {
        setMessages(prev => [...prev, { id: nextId(), role: 'assistant' as const, content: turnTextRef.current + '\n\n*(已中断)*' }])
      }
      resetTurn()
      send({ type: 'abort' })
    }
    // 追加用户消息时带上 imageIds
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user' as const,
      content: text,
      source: 'web' as const,
      ...(imageIds?.length ? { imageIds } : {}),
    }])
    setStreaming('')
    setIsStreaming(true)
    turnTextRef.current = ''
    turnToolsRef.current = []
    // WS 发送时携带 imageIds
    setTimeout(() => send({ type: 'chat', text, ...(imageIds?.length ? { imageIds } : {}) }), 50)
  }, [send, isStreaming])

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">CCode</h1>
          {sessionId && <span className="text-xs text-txt-secondary font-mono">{sessionId.slice(0, 8)}</span>}
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
          <button
            onClick={() => setMemoryPanelOpen(prev => !prev)}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              memoryPanelOpen
                ? 'bg-purple-900 text-purple-300'
                : 'bg-elevated text-txt-secondary hover:bg-elevated'
            }`}
            title="记忆全景"
          >
            记忆
          </button>
          <button
            onClick={() => {
              if (window.confirm('确定关闭 Bridge Server？所有 Web 客户端将断开连接。')) {
                fetch('/api/bridge/stop', { method: 'POST' }).catch(() => {})
              }
            }}
            className="text-xs px-2 py-1 rounded bg-red-900/50 text-error hover:bg-red-800 transition-colors"
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

        {/* 思考中动效 */}
        {thinking && !streaming && (
          <div className="flex justify-start mb-3">
            <div className="max-w-[80%] rounded-lg px-4 py-3 bg-elevated text-txt-primary">
              <ThinkingDots />
            </div>
          </div>
        )}

        {/* 流式输出 */}
        {streaming && (
          <div className="flex justify-start mb-3">
            <div className="max-w-[80%] rounded-lg px-4 py-3 bg-elevated text-txt-primary">
              <p className="whitespace-pre-wrap text-sm">{streaming}</p>
            </div>
          </div>
        )}

        {/* Compact 进行中动效 */}
        {compacting && (
          <div className="flex justify-start mb-3">
            <div className="max-w-[80%] rounded-lg px-4 py-3 bg-elevated border border-blue-500/30">
              <div className="flex items-center gap-2 text-sm text-accent">
                <span className="animate-spin">⟳</span>
                <span>{compacting.message}</span>
              </div>
              <div className="text-xs text-txt-secondary mt-1">
                Strategy: <span className="text-accent">{compacting.strategy}</span>
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
            onAllow={() => { send({ type: 'permission', allow: true, always: false }); setPendingPermission(null) }}
            onAlwaysAllow={() => { send({ type: 'permission', allow: true, always: true }); setPendingPermission(null) }}
            onDeny={() => { send({ type: 'permission', allow: false, always: false }); setPendingPermission(null) }}
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

      <StatusBar data={statusBarData} />

      <MemoryPanel open={memoryPanelOpen} onClose={() => setMemoryPanelOpen(false)} />

      <SubAgentDrawer
        agents={subAgents}
        onStop={(agentId) => send({ type: 'subagent_stop', agentId, reason: 'user' })}
      />
    </div>
  )
}

/** 思考中动效 — 与 CLI 端 Ink Spinner dots 一致的 braille 旋转 */
const DOTS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function ThinkingDots() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % DOTS_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex items-center gap-1.5 text-sm text-txt-secondary">
      <span className="font-mono text-cyan-400">{DOTS_FRAMES[frame]}</span>
      <span>思考中...</span>
    </div>
  )
}

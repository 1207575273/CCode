// src/pages/ConversationsPage.tsx

import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../hooks/useApi'
import { MessageBubble } from '../components/MessageBubble'
import type { ChatMessage, SubagentSnapshot } from '../types'
import type { SubAgentInfo, SubAgentDetailEvent } from '../components/SubAgentCard'

interface SessionSummary {
  sessionId: string
  model: string
  provider: string
  messageCount: number
  updatedAt: string
  firstMessage: string
}

interface SessionDetail {
  sessionId: string
  provider: string
  model: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    model?: string
    provider?: string
    thinking?: string
    usage?: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
    llmCallCount?: number
    toolCallCount?: number
    toolEvents?: Array<{
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      durationMs?: number
      success?: boolean
      resultSummary?: string
      resultFull?: string
    }>
  }>
  subagents?: SubagentSnapshot[]
}

export function ConversationsPage() {
  const { id } = useParams<{ id: string }>()

  if (id) return <ConversationDetail sessionId={id} />
  return <ConversationList />
}

function ConversationList() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [resumingId, setResumingId] = useState<string | null>(null)

  useEffect(() => {
    apiGet<{ sessions: SessionSummary[] }>('/api/conversations?limit=100')
      .then(d => setSessions(d.sessions))
      .catch(e => setError(String(e)))
  }, [])

  // 按 sessionId / firstMessage / provider 模糊搜索
  const filtered = useMemo(() => {
    if (!search.trim()) return sessions
    const q = search.toLowerCase()
    return sessions.filter(s =>
      s.sessionId.toLowerCase().includes(q) ||
      (s.firstMessage ?? '').toLowerCase().includes(q) ||
      (s.provider ?? '').toLowerCase().includes(q)
    )
  }, [sessions, search])

  if (error) return <div className="p-6 text-error">加载失败: {error}</div>

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">对话历史</h2>
        <span className="text-xs text-txt-secondary">{filtered.length} / {sessions.length} 条</span>
      </div>

      {/* 搜索框 */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="搜索 sessionId / 消息内容 / provider..."
        className="w-full bg-elevated text-sm rounded-lg px-4 py-2.5 mb-4 outline-none focus:ring-1 focus:border-accent placeholder-txt-muted"
      />

      {filtered.length === 0 ? (
        <p className="text-txt-secondary">{search ? '无匹配结果' : '暂无会话记录'}</p>
      ) : (
        <div className="space-y-2">
          {filtered.map(s => (
            <div
              key={s.sessionId}
              className="flex items-center justify-between p-4 bg-elevated rounded-lg hover:bg-elevated transition-colors"
            >
              {/* 左侧：点击跳转到回放详情 */}
              <Link to={`/conversations/${s.sessionId}`} className="min-w-0 flex-1 mr-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-txt-secondary">{s.sessionId.slice(0, 12)}</span>
                  {s.provider && <span className="text-xs bg-elevated px-1.5 py-0.5 rounded text-txt-secondary">{s.provider}</span>}
                </div>
                {s.firstMessage && (
                  <p className="text-sm text-txt-primary mt-1 truncate">{s.firstMessage}</p>
                )}
              </Link>
              {/* 右侧：时间 + 恢复按钮 */}
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-xs text-txt-secondary">{new Date(s.updatedAt).toLocaleString()}</div>
                <button
                  onClick={async () => {
                    setResumingId(s.sessionId)
                    try {
                      await apiPost('/api/session/resume', { sessionId: s.sessionId })
                      navigate(`/session/${s.sessionId}`)
                    } catch (err) {
                      console.warn('[Conversations] 恢复对话失败:', err)
                      setResumingId(null)
                    }
                  }}
                  disabled={resumingId === s.sessionId}
                  className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 whitespace-nowrap"
                  title="恢复此对话继续聊天"
                >
                  {resumingId === s.sessionId ? '恢复中...' : '恢复'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 回放速度选项（毫秒/条） */
const SPEED_OPTIONS = [
  { label: '慢', ms: 800 },
  { label: '中', ms: 400 },
  { label: '快', ms: 150 },
  { label: '瞬间', ms: 0 },
]

function ConversationDetail({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 回放状态
  const [visibleCount, setVisibleCount] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(0) // 默认"慢"
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiGet<SessionDetail>(`/api/conversations/${sessionId}`)
      .then(d => {
        setDetail(d)
        // 加载完后自动开始回放
        setVisibleCount(0)
        setIsPlaying(true)
      })
      .catch(e => setError(String(e)))
  }, [sessionId])

  // 将 messages 转为 ChatMessage
  const messages: ChatMessage[] = useMemo(() => {
    if (!detail) return []
    return detail.messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ...(m.model ? { model: m.model } : {}),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
      ...(m.llmCallCount ? { llmCallCount: m.llmCallCount } : {}),
      ...(m.toolCallCount ? { toolCallCount: m.toolCallCount } : {}),
      ...(m.toolEvents && m.toolEvents.length > 0 ? {
        toolEvents: m.toolEvents.map(t => ({ ...t, status: 'done' as const }))
      } : {}),
    }))
  }, [detail])

  // 从 API 返回的 subagents 构建 SubAgentInfo Map
  const subAgents: Map<string, SubAgentInfo> = useMemo(() => {
    const map = new Map<string, SubAgentInfo>()
    if (!detail?.subagents) return map
    for (const sa of detail.subagents) {
      map.set(sa.agentId, {
        agentId: sa.agentId,
        description: sa.description,
        status: sa.status,
        turn: 0,
        maxTurns: 25,
        events: sa.events.map(e => {
          const evt: SubAgentDetailEvent = { type: e.kind }
          if (e.kind === 'tool_start' || e.kind === 'tool_done') {
            evt.toolName = e.toolName
          }
          if (e.kind === 'tool_done') {
            evt.durationMs = e.durationMs
            evt.success = e.success
            evt.resultSummary = e.resultSummary
          }
          if (e.kind === 'text') {
            evt.text = e.text
          }
          if (e.kind === 'error') {
            evt.error = e.error
          }
          return evt
        }),
      })
    }
    return map
  }, [detail])

  // 回放定时器
  useEffect(() => {
    if (!isPlaying || visibleCount >= messages.length) {
      setIsPlaying(false)
      return
    }
    const speed = SPEED_OPTIONS[speedIdx]!.ms
    if (speed === 0) {
      // 瞬间模式：直接显示全部
      setVisibleCount(messages.length)
      setIsPlaying(false)
      return
    }
    timerRef.current = setTimeout(() => {
      setVisibleCount(prev => prev + 1)
    }, speed)
    return () => clearTimeout(timerRef.current)
  }, [isPlaying, visibleCount, messages.length, speedIdx])

  // 自动滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [visibleCount])

  // 清理
  useEffect(() => () => clearTimeout(timerRef.current), [])

  if (error) return <div className="p-6 text-error">加载失败: {error}</div>
  if (!detail) return <div className="p-6 text-txt-secondary">加载中...</div>

  const allVisible = visibleCount >= messages.length
  const progress = messages.length > 0 ? Math.round((visibleCount / messages.length) * 100) : 0

  return (
    <div className="p-6 max-w-4xl">
      {/* 头部 */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate(-1)} className="text-txt-secondary hover:text-txt-primary">&larr; 返回</button>
        <h2 className="text-xl font-bold">会话回放</h2>
        <span className="text-xs bg-elevated px-2 py-0.5 rounded text-txt-secondary">{detail.model}</span>
        <span className="text-xs text-txt-secondary font-mono">{sessionId.slice(0, 8)}</span>
      </div>

      {/* 回放控制栏 */}
      <div className="flex items-center gap-3 mb-4 p-3 bg-elevated rounded-lg">
        {/* 播放/暂停 */}
        <button
          onClick={() => {
            if (allVisible) { setVisibleCount(0); setIsPlaying(true) }
            else setIsPlaying(!isPlaying)
          }}
          className="px-3 py-1 bg-accent text-white text-sm rounded hover:bg-accent-hover"
        >
          {allVisible ? '重播' : isPlaying ? '暂停' : '播放'}
        </button>

        {/* 跳到末尾 */}
        {!allVisible && (
          <button
            onClick={() => { setVisibleCount(messages.length); setIsPlaying(false) }}
            className="px-3 py-1 bg-elevated text-txt-primary text-sm rounded hover:bg-elevated"
          >
            显示全部
          </button>
        )}

        {/* 速度选择 */}
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-txt-secondary">速度:</span>
          {SPEED_OPTIONS.map((opt, i) => (
            <button key={opt.label} onClick={() => setSpeedIdx(i)}
              className={`px-2 py-0.5 text-xs rounded ${i === speedIdx ? 'bg-accent text-white' : 'bg-elevated text-txt-secondary hover:bg-elevated'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* 进度 */}
        <span className="text-xs text-txt-secondary ml-auto">{visibleCount} / {messages.length} ({progress}%)</span>

        {/* 恢复对话：跳转到实时聊天继续 */}
        <button
          onClick={async () => {
            try {
              await apiPost('/api/session/resume', { sessionId })
              navigate(`/session/${sessionId}`)
            } catch (err) { console.warn('[Conversations] 恢复对话失败:', err) }
          }}
          className="px-3 py-1.5 bg-success text-white text-sm rounded hover:bg-success whitespace-nowrap"
          title="恢复此对话，跳转到实时聊天继续提问"
        >
          恢复对话
        </button>
      </div>

      {/* 消息区域 */}
      <div className="space-y-1">
        {messages.slice(0, visibleCount).map((msg, i) => (
          <div key={msg.id} className="animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
            <MessageBubble message={msg} subAgents={subAgents} />
          </div>
        ))}
        {allVisible && messages.length === 0 && (
          <p className="text-txt-secondary text-sm">空会话（无消息）</p>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

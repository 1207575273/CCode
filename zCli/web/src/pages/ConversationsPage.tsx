// src/pages/ConversationsPage.tsx

import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { apiGet } from '../hooks/useApi'
import { MessageBubble } from '../components/MessageBubble'
import type { ChatMessage } from '../types'

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
    toolEvents?: Array<{
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      durationMs?: number
      success?: boolean
      resultSummary?: string
    }>
  }>
}

export function ConversationsPage() {
  const { id } = useParams<{ id: string }>()

  if (id) return <ConversationDetail sessionId={id} />
  return <ConversationList />
}

function ConversationList() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

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

  if (error) return <div className="p-6 text-red-400">加载失败: {error}</div>

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">对话历史</h2>
        <span className="text-xs text-gray-500">{filtered.length} / {sessions.length} 条</span>
      </div>

      {/* 搜索框 */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="搜索 sessionId / 消息内容 / provider..."
        className="w-full bg-gray-800 text-sm rounded-lg px-4 py-2.5 mb-4 outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
      />

      {filtered.length === 0 ? (
        <p className="text-gray-500">{search ? '无匹配结果' : '暂无会话记录'}</p>
      ) : (
        <div className="space-y-2">
          {filtered.map(s => (
            <Link
              key={s.sessionId}
              to={`/conversations/${s.sessionId}`}
              className="flex items-center justify-between p-4 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
            >
              <div className="min-w-0 flex-1 mr-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-gray-400">{s.sessionId.slice(0, 12)}</span>
                  {s.provider && <span className="text-xs bg-gray-700 px-1.5 py-0.5 rounded text-gray-400">{s.provider}</span>}
                </div>
                {s.firstMessage && (
                  <p className="text-sm text-gray-300 mt-1 truncate">{s.firstMessage}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs text-gray-500">{new Date(s.updatedAt).toLocaleString()}</div>
              </div>
            </Link>
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
      ...(m.toolEvents && m.toolEvents.length > 0 ? {
        toolEvents: m.toolEvents.map(t => ({ ...t, status: 'done' as const }))
      } : {}),
    }))
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

  if (error) return <div className="p-6 text-red-400">加载失败: {error}</div>
  if (!detail) return <div className="p-6 text-gray-500">加载中...</div>

  const allVisible = visibleCount >= messages.length
  const progress = messages.length > 0 ? Math.round((visibleCount / messages.length) * 100) : 0

  return (
    <div className="p-6 max-w-4xl">
      {/* 头部 */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-gray-200">&larr; 返回</button>
        <h2 className="text-xl font-bold">会话回放</h2>
        <span className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-400">{detail.model}</span>
        <span className="text-xs text-gray-500 font-mono">{sessionId.slice(0, 8)}</span>
      </div>

      {/* 回放控制栏 */}
      <div className="flex items-center gap-3 mb-4 p-3 bg-gray-800 rounded-lg">
        {/* 播放/暂停 */}
        <button
          onClick={() => {
            if (allVisible) { setVisibleCount(0); setIsPlaying(true) }
            else setIsPlaying(!isPlaying)
          }}
          className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-500"
        >
          {allVisible ? '重播' : isPlaying ? '暂停' : '播放'}
        </button>

        {/* 跳到末尾 */}
        {!allVisible && (
          <button
            onClick={() => { setVisibleCount(messages.length); setIsPlaying(false) }}
            className="px-3 py-1 bg-gray-700 text-gray-300 text-sm rounded hover:bg-gray-600"
          >
            显示全部
          </button>
        )}

        {/* 速度选择 */}
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-gray-500">速度:</span>
          {SPEED_OPTIONS.map((opt, i) => (
            <button key={opt.label} onClick={() => setSpeedIdx(i)}
              className={`px-2 py-0.5 text-xs rounded ${i === speedIdx ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* 进度 */}
        <span className="text-xs text-gray-500 ml-auto">{visibleCount} / {messages.length} ({progress}%)</span>
      </div>

      {/* 消息区域 */}
      <div className="space-y-1">
        {messages.slice(0, visibleCount).map((msg, i) => (
          <div key={msg.id} className="animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
            <MessageBubble message={msg} />
          </div>
        ))}
        {allVisible && messages.length === 0 && (
          <p className="text-gray-500 text-sm">空会话（无消息）</p>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

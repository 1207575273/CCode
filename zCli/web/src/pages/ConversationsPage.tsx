// src/pages/ConversationsPage.tsx

import { useState, useEffect, useMemo } from 'react'
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

function ConversationDetail({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiGet<SessionDetail>(`/api/conversations/${sessionId}`)
      .then(setDetail)
      .catch(e => setError(String(e)))
  }, [sessionId])

  if (error) return <div className="p-6 text-red-400">加载失败: {error}</div>
  if (!detail) return <div className="p-6 text-gray-500">加载中...</div>

  // 将 SessionDetail.messages 转为 ChatMessage 格式
  const messages: ChatMessage[] = detail.messages.map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.toolEvents && m.toolEvents.length > 0 ? {
      toolEvents: m.toolEvents.map(t => ({
        ...t,
        status: 'done' as const,
      }))
    } : {}),
  }))

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-gray-200">&larr; 返回</button>
        <h2 className="text-xl font-bold">会话详情</h2>
        <span className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-400">{detail.model}</span>
        <span className="text-xs text-gray-500 font-mono">{sessionId.slice(0, 8)}</span>
      </div>

      <div className="space-y-1">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {messages.length === 0 && (
          <p className="text-gray-500 text-sm">空会话（无消息）</p>
        )}
      </div>
    </div>
  )
}

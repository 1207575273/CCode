// web/src/components/SubAgentDrawer.tsx

/**
 * SubAgentDrawer — 悬浮按钮 + 右侧抽屉面板，全局查看所有 SubAgent 实时状态。
 *
 * 组成：
 * 1. FAB 悬浮按钮（fixed right-bottom）— 有 agent 时显示，badge 标注运行中数量
 * 2. Drawer 抽屉面板（fixed right-side）— Agent 列表 + 可展开的事件流
 *
 * 数据来源：ChatPage 的 subAgents state，通过 props 传入，零后端改动。
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import type { SubAgentInfo, SubAgentDetailEvent } from './SubAgentCard'

// ═══════════════════════════════════════════════
// Props
// ═══════════════════════════════════════════════

interface SubAgentDrawerProps {
  agents: Map<string, SubAgentInfo>
  /** 停止子 Agent 回调 */
  onStop?: (agentId: string) => void
}

// ═══════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════

export function SubAgentDrawer({ agents, onStop }: SubAgentDrawerProps) {
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const agentList = useMemo(() => {
    const list = Array.from(agents.values())
    // running 置顶 → done → error，同状态保持插入顺序
    const order: Record<string, number> = { running: 0, done: 1, error: 2 }
    return list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [agents])

  const runningCount = useMemo(
    () => agentList.filter(a => a.status === 'running').length,
    [agentList],
  )

  // 无 agent 时完全隐藏
  if (agentList.length === 0) return null

  return (
    <>
      {/* FAB 悬浮按钮 */}
      <button
        onClick={() => setOpen(prev => !prev)}
        className={`
          fixed right-6 bottom-40 z-50
          w-12 h-12 rounded-full
          bg-elevated/90 border border-border
          flex items-center justify-center
          hover:bg-elevated active:scale-95
          transition-all duration-200 cursor-pointer
          ${runningCount > 0 ? 'animate-pulse' : ''}
        `}
        title={`SubAgents (${agentList.length})`}
      >
        <span className="text-lg">🤖</span>
        {/* Badge */}
        {runningCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-warning text-txt-primary text-xs font-bold flex items-center justify-center">
            {runningCount}
          </span>
        )}
        {runningCount === 0 && agentList.length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-elevated text-txt-primary text-xs font-bold flex items-center justify-center">
            {agentList.length}
          </span>
        )}
      </button>

      {/* 遮罩层 */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* 抽屉面板 */}
      <div
        className={`
          fixed top-0 right-0 h-full z-40
          w-[36rem] max-w-full
          bg-surface border-l border-border
          transform transition-transform duration-300 ease-in-out
          flex flex-col
          ${open ? 'translate-x-0' : 'translate-x-full'}
        `}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-txt-primary">SubAgents</span>
            <span className="text-xs text-txt-secondary">({agentList.length})</span>
            {runningCount > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-300">
                {runningCount} running
              </span>
            )}
          </div>
          <button
            onClick={() => setOpen(false)}
            className="text-txt-secondary hover:text-txt-primary transition-colors text-lg leading-none cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Agent 列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {agentList.map(agent => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              expanded={expandedId === agent.agentId}
              onToggle={() => setExpandedId(prev =>
                prev === agent.agentId ? null : agent.agentId,
              )}
              onStop={onStop}
            />
          ))}
        </div>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════
// Agent 行组件
// ═══════════════════════════════════════════════

interface AgentRowProps {
  agent: SubAgentInfo
  expanded: boolean
  onToggle: () => void
  onStop?: (agentId: string) => void
}

function AgentRow({ agent, expanded, onToggle, onStop }: AgentRowProps) {
  const statusIcon = agent.status === 'running' || agent.status === 'stopping'
    ? '⟳'
    : agent.status === 'done'
      ? '✓'
      : agent.status === 'stopped'
        ? '◼'
        : '✗'
  const statusColor = agent.status === 'running'
    ? 'text-warning'
    : agent.status === 'stopping'
      ? 'text-orange-400'
      : agent.status === 'done'
        ? 'text-success'
        : agent.status === 'stopped'
          ? 'text-warning'
          : 'text-error'

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* 折叠头 */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-elevated hover:bg-elevated transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`${statusColor} font-mono text-sm shrink-0`}>
            {(agent.status === 'running' || agent.status === 'stopping') ? <Spinner /> : statusIcon}
          </span>
          {agent.agentType && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-elevated text-txt-secondary font-mono shrink-0">
              {agent.agentType}
            </span>
          )}
          <span className="text-sm font-medium text-txt-primary truncate">
            {agent.name ?? agent.description}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {agent.status === 'running' && (
            <span className="text-[10px] text-txt-secondary">
              turn {agent.turn}/{agent.maxTurns}
              {agent.currentTool && (
                <span className="text-warning/70"> ▸ {agent.currentTool}</span>
              )}
            </span>
          )}
          {agent.status === 'stopping' && (
            <span className="text-[10px] text-orange-400">正在停止...</span>
          )}
          {/* 停止按钮 */}
          {agent.status === 'running' && onStop && (
            <button
              onClick={(e) => { e.stopPropagation(); onStop(agent.agentId) }}
              className="px-1.5 py-0.5 text-[10px] rounded bg-red-900/50 text-red-300 hover:bg-red-800/70 transition-colors cursor-pointer"
              title="停止此 Agent"
            >
              ⏹ 停止
            </button>
          )}
          <span className="text-txt-muted text-[10px]">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* 展开详情：事件流 */}
      {expanded && <EventList events={agent.events} />}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 事件列表组件
// ═══════════════════════════════════════════════

function EventList({ events }: { events: SubAgentDetailEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // 新事件自动滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  if (events.length === 0) {
    return (
      <div className="px-3 py-2 bg-surface/50">
        <p className="text-xs text-txt-secondary italic">(等待事件...)</p>
      </div>
    )
  }

  // tool_start 和 tool_done 合并：tool_start 不单独显示，等 tool_done 一起展示
  const filtered = events.filter(e => e.type !== 'tool_start')

  return (
    <div className="px-3 py-2 bg-surface/50 space-y-1 max-h-[32rem] overflow-y-auto">
      {filtered.map((evt, i) => (
        <EventLine key={i} event={evt} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

/** 渲染单条事件 */
function EventLine({ event }: { event: SubAgentDetailEvent }) {
  switch (event.type) {
    case 'tool_done':
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className={event.success ? 'text-success' : 'text-error'} shrink-0>
            {event.success ? '✓' : '✗'}
          </span>
          <span className="text-txt-primary font-mono">{event.toolName}</span>
          {event.durationMs != null && (
            <span className="text-txt-secondary">{formatDuration(event.durationMs)}</span>
          )}
          {event.resultSummary && (
            <span className="text-txt-secondary truncate max-w-[250px]">
              ⎿ {event.resultSummary.split('\n')[0]}
            </span>
          )}
        </div>
      )
    case 'text':
      return (
        <div className="text-xs text-txt-primary pl-4 py-0.5 border-l-2 border-cyan-800 whitespace-pre-wrap break-all">
          {event.text}
        </div>
      )
    case 'error':
      return (
        <div className="text-xs text-error pl-1">✗ {event.error}</div>
      )
    default:
      return null
  }
}

// ═══════════════════════════════════════════════
// 辅助组件 & 函数
// ═══════════════════════════════════════════════

/** CSS 动画 Spinner（避免引入额外依赖） */
function Spinner() {
  return (
    <span className="inline-block animate-spin text-warning" style={{ animationDuration: '1s' }}>
      ⟳
    </span>
  )
}

/** 格式化耗时 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return `${min}m${sec}s`
}

// web/src/components/SubAgentCard.tsx

/**
 * SubAgentCard — 对话流中的子 Agent 折叠卡片。
 *
 * 默认折叠显示摘要（状态 + 当前工具），点击展开查看详情。
 */

import { useState } from 'react'

export interface SubAgentInfo {
  agentId: string
  /** 人类可读名称 */
  name?: string
  /** Agent 类型（general / explore / plan / 自定义） */
  agentType?: string
  description: string
  status: 'running' | 'stopping' | 'stopped' | 'done' | 'error'
  turn: number
  maxTurns: number
  currentTool?: string
  /** 详细事件（展开时显示） */
  events: SubAgentDetailEvent[]
}

export interface SubAgentDetailEvent {
  type: 'tool_start' | 'tool_done' | 'text' | 'error'
  toolName?: string
  durationMs?: number
  success?: boolean
  resultSummary?: string
  text?: string
  error?: string
}

interface SubAgentCardProps {
  agent: SubAgentInfo
}

export function SubAgentCard({ agent }: SubAgentCardProps) {
  const [expanded, setExpanded] = useState(false)

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
    <div className="my-2 border border-border rounded-lg overflow-hidden">
      {/* 折叠头 */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 bg-elevated hover:bg-elevated transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className={`${statusColor} font-mono`}>{statusIcon}</span>
          {agent.agentType && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-elevated text-txt-secondary font-mono">
              {agent.agentType}
            </span>
          )}
          <span className="text-sm font-medium text-txt-primary">
            {agent.name ?? agent.description}
          </span>
          {(agent.status === 'running' || agent.status === 'stopping') && (
            <span className="text-xs text-txt-secondary">
              {agent.status === 'stopping' ? (
                <span className="text-orange-400">正在停止...</span>
              ) : (
                <>
                  turn {agent.turn}/{agent.maxTurns}
                  {agent.currentTool && <> ▸ {agent.currentTool}</>}
                </>
              )}
            </span>
          )}
        </div>
        <span className="text-txt-secondary text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* 展开详情：完整的对话流（工具调用 + AI 文本 + 错误） */}
      {expanded && (
        <div className="px-3 py-2 bg-surface/50 space-y-1 max-h-80 overflow-y-auto">
          {agent.events.length === 0 ? (
            <p className="text-xs text-txt-secondary">(等待事件...)</p>
          ) : (
            agent.events
              .filter(e => e.type !== 'tool_start') // tool_start 和 tool_done 合并显示
              .map((evt, i) => (
                <div key={i}>
                  {evt.type === 'tool_done' && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className={evt.success ? 'text-success' : 'text-error'}>
                        {evt.success ? '✓' : '✗'}
                      </span>
                      <span className="text-txt-primary font-mono">{evt.toolName}</span>
                      {evt.durationMs != null && (
                        <span className="text-txt-secondary">{evt.durationMs}ms</span>
                      )}
                      {evt.resultSummary && (
                        <span className="text-txt-secondary truncate max-w-[300px]">
                          ⎿ {evt.resultSummary.split('\n')[0]}
                        </span>
                      )}
                    </div>
                  )}
                  {evt.type === 'text' && evt.text && (
                    <div className="text-xs text-txt-primary pl-4 py-1 border-l-2 border-cyan-800 whitespace-pre-wrap">
                      {evt.text}
                    </div>
                  )}
                  {evt.type === 'error' && (
                    <div className="text-xs text-error">✗ {evt.error}</div>
                  )}
                </div>
              ))
          )}
        </div>
      )}
    </div>
  )
}

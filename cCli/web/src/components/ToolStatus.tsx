// src/components/ToolStatus.tsx

/**
 * 统一的工具执行状态渲染组件。
 *
 * 用于两个场景：
 * 1. 实时执行中（running）— 黄色脉冲图标 + 参数摘要
 * 2. 执行历史（done）— 折叠式，点击展开结果子块
 *
 * 样式对齐 CLI 端的 ToolStatusLine。
 */

import { useState, useCallback } from 'react'
import type { ToolEvent } from '../types'
import { SubAgentCard } from './SubAgentCard'
import type { SubAgentInfo } from './SubAgentCard'

/** 工具名 → 显示名映射 */
const DISPLAY_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Update',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  dispatch_agent: 'Agent',
  ask_user_question: 'AskUser',
}

/** 从 args 中提取关键参数作为摘要 */
function formatArgsSummary(_toolName: string, args: Record<string, unknown>): string {
  if (args['file_path']) return String(args['file_path'])
  if (args['path']) return String(args['path'])
  if (args['pattern']) return String(args['pattern'])
  if (args['command']) {
    const cmd = String(args['command'])
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
  }
  if (args['description']) {
    const desc = String(args['description'])
    return desc.length > 60 ? desc.slice(0, 57) + '...' : desc
  }
  // MCP 等未知工具：取第一个字符串参数
  const firstStr = Object.values(args).find(v => typeof v === 'string')
  if (typeof firstStr === 'string') {
    return firstStr.length > 60 ? firstStr.slice(0, 57) + '...' : firstStr
  }
  return ''
}

/** 输出预览最大行数 */
const MAX_PREVIEW_LINES = 4

interface Props {
  events: ToolEvent[]
  /** SubAgent 数据，用于在 dispatch_agent 工具条目旁渲染详情卡片 */
  subAgents?: Map<string, SubAgentInfo>
}

/** 从 dispatch_agent 的 resultSummary 中提取 agentId */
function extractAgentId(resultSummary?: string): string | null {
  if (!resultSummary) return null
  const match = resultSummary.match(/agentId:\s*([a-f0-9]+)/)
  return match?.[1] ?? null
}

export function ToolStatus({ events, subAgents }: Props) {
  if (events.length === 0) return null
  return (
    <div className="py-1 space-y-1">
      {events.map(e => {
        // dispatch_agent 工具：尝试匹配关联的 SubAgentCard
        const agentId = e.toolName === 'dispatch_agent' ? extractAgentId(e.resultSummary) : null
        const agentInfo = agentId && subAgents ? subAgents.get(agentId) : undefined

        return (
          <div key={e.toolCallId}>
            <ToolStatusItem event={e} />
            {agentInfo && <SubAgentCard agent={agentInfo} />}
          </div>
        )
      })}
    </div>
  )
}

function ToolStatusItem({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded(prev => !prev), [])

  const isRunning = event.status === 'running'
  const name = DISPLAY_NAMES[event.toolName] ?? event.toolName
  const summary = formatArgsSummary(event.toolName, event.args)
  const dur = event.durationMs != null ? `${event.durationMs}ms` : ''

  // 状态图标和颜色
  const icon = isRunning ? '⟳' : event.success ? '✓' : '✗'
  const iconClass = isRunning
    ? 'animate-pulse text-yellow-400'
    : event.success ? 'text-green-400' : 'text-red-400'
  const textClass = isRunning ? 'text-gray-400' : event.success ? 'text-green-400/80' : 'text-red-400/80'

  // 输出子块
  const hasOutput = !isRunning && Boolean(event.resultSummary?.trim())
  const outputLines = event.resultSummary?.split('\n') ?? []
  const previewLines = outputLines.slice(0, MAX_PREVIEW_LINES)
  const remaining = outputLines.length - previewLines.length

  return (
    <div className="text-sm">
      {/* 头部行 */}
      <div
        onClick={hasOutput ? toggle : undefined}
        className={`flex items-center gap-1.5 py-0.5 ${hasOutput ? 'cursor-pointer hover:bg-gray-800/30 rounded px-1 -mx-1' : ''}`}
      >
        <span className={iconClass}>{icon}</span>
        <span className={`font-mono ${textClass}`}>
          {name}
        </span>
        {summary && <span className="text-gray-500 font-mono">({summary})</span>}
        {dur && <span className="text-gray-600 ml-1">{dur}</span>}
        {hasOutput && (
          <span className="text-gray-600 ml-1 text-xs">{expanded ? '▼' : '▶'}</span>
        )}
      </div>

      {/* 输出子块：border-left + 缩进 */}
      {hasOutput && expanded && (
        <div className="ml-5 mt-0.5 border-l-2 border-gray-700 pl-2 mb-1">
          {previewLines.map((line, i) => (
            <pre key={i} className="text-xs text-gray-500 font-mono whitespace-pre-wrap leading-relaxed">
              {line}
            </pre>
          ))}
          {remaining > 0 && (
            <span className="text-xs text-gray-600">... +{remaining} lines</span>
          )}
        </div>
      )}
    </div>
  )
}

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

import { useState, useCallback, useEffect } from 'react'
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

/**
 * 从工具 args 中提取可展示的详细内容。
 * 某些工具（write_file/edit_file）的 output 只有摘要，但 args 里有完整数据。
 */
function extractArgsDetail(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'write_file') {
    const content = args['content']
    const path = args['file_path'] ?? args['path'] ?? ''
    if (typeof content === 'string') {
      return `📄 ${path}\n${'─'.repeat(40)}\n${content}`
    }
  }
  if (toolName === 'edit_file') {
    const oldStr = args['old_string']
    const newStr = args['new_string']
    const path = args['file_path'] ?? args['path'] ?? ''
    if (typeof oldStr === 'string' && typeof newStr === 'string') {
      return `📄 ${path}\n${'─'.repeat(20)} old ${'─'.repeat(20)}\n${oldStr}\n${'─'.repeat(20)} new ${'─'.repeat(20)}\n${newStr}`
    }
  }
  if (toolName === 'bash') {
    const cmd = args['command']
    if (typeof cmd === 'string') {
      return `$ ${cmd}`
    }
  }
  return null
}

interface Props {
  events: ToolEvent[]
  /** SubAgent 数据，用于在 dispatch_agent 工具条目旁渲染详情卡片 */
  subAgents?: Map<string, SubAgentInfo>
}

/** 从 dispatch_agent 的输出文本中提取 agentId（降级方案，优先使用结构化 agentId 字段） */
function extractAgentId(text?: string): string | null {
  if (!text) return null
  // JSON 格式："agentId":"abc123def456789"
  const jsonMatch = text.match(/"agentId"\s*:\s*"([a-f0-9]+)"/)
  if (jsonMatch?.[1]) return jsonMatch[1]
  // 旧格式兼容：agentId: abc123def456789
  const plainMatch = text.match(/agentId:\s*([a-f0-9]+)/)
  return plainMatch?.[1] ?? null
}

export function ToolStatus({ events, subAgents }: Props) {
  if (events.length === 0) return null
  return (
    <div className="py-1 space-y-1">
      {events.map(e => {
        // dispatch_agent 工具：优先结构化 agentId，降级到正则提取
        const agentId = e.toolName === 'dispatch_agent'
          ? (e.agentId ?? extractAgentId(e.resultFull ?? e.resultSummary))
          : null
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

/** 实时计时 hook — 仅 running 状态使用，>=3s 才返回可见文本 */
function useElapsedTimer(startedAt?: number): string {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return elapsed >= 3 ? `${elapsed}s` : ''
}

function ToolStatusItem({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded(prev => !prev), [])

  const isRunning = event.status === 'running'
  const name = DISPLAY_NAMES[event.toolName] ?? event.toolName
  const summary = formatArgsSummary(event.toolName, event.args)

  const runningTimer = useElapsedTimer(isRunning ? event.startedAt : undefined)
  const dur = isRunning ? runningTimer : (event.durationMs != null ? `${event.durationMs}ms` : '')

  // 状态图标和颜色
  const icon = isRunning ? '⟳' : event.success ? '✓' : '✗'
  const iconClass = isRunning
    ? 'animate-pulse text-yellow-400'
    : event.success ? 'text-green-400' : 'text-red-400'
  const textClass = isRunning ? 'text-gray-400' : event.success ? 'text-green-400/80' : 'text-red-400/80'

  // 输出内容：优先使用 resultFull（Web 完整展示），fallback 到 resultSummary（旧数据兼容）
  const outputContent = event.resultFull ?? event.resultSummary ?? ''
  // 从 args 中提取详细内容（write_file 的完整文件内容、edit_file 的 diff 等）
  const argsDetail = extractArgsDetail(event.toolName, event.args)
  // 合并展示：args 详情（输入）+ output（执行结果）
  const fullDisplay = [argsDetail, outputContent.trim() ? outputContent : null].filter(Boolean).join('\n\n📋 输出:\n')
  const hasOutput = !isRunning && Boolean(fullDisplay.trim())
  const hasFull = Boolean(event.resultFull?.trim()) || Boolean(argsDetail)

  // 折叠态预览：取前 4 行
  const outputLines = fullDisplay.split('\n')
  const previewLines = outputLines.slice(0, MAX_PREVIEW_LINES)
  const remaining = outputLines.length - previewLines.length
  const charCount = fullDisplay.length

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

      {/* 输出子块 */}
      {hasOutput && expanded && (
        <div className="ml-5 mt-0.5 border-l-2 border-gray-700 pl-2 mb-1">
          {hasFull ? (
            <>
              {/* 完整内容：滚动容器 */}
              <pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto bg-gray-900/50 rounded p-2">
                {fullDisplay}
              </pre>
              {charCount > 500 && (
                <span className="text-xs text-gray-600 mt-0.5 block">
                  {charCount.toLocaleString()} chars · {outputLines.length} lines
                </span>
              )}
            </>
          ) : (
            <>
              {/* 旧数据 fallback：摘要预览 */}
              {previewLines.map((line, i) => (
                <pre key={i} className="text-xs text-gray-500 font-mono whitespace-pre-wrap leading-relaxed">
                  {line}
                </pre>
              ))}
              {remaining > 0 && (
                <span className="text-xs text-gray-600">... +{remaining} lines</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

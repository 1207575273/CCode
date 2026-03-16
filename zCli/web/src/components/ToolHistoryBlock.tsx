// src/components/ToolHistoryBlock.tsx

/**
 * 工具执行历史记录块 — 折叠式渲染，模仿 CLI 的 ToolStatusLine 样式。
 *
 * 默认折叠只显示头部行：✓ Write(test/hello.txt) 7ms
 * 展开后显示结果子块：⎿ Hello World!
 */

import { useState, useCallback } from 'react'
import type { ToolEvent } from '../types.js'

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

/** 从 args 提取参数摘要 */
function argsSummary(_toolName: string, args: Record<string, unknown>): string {
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
  return ''
}

/** 输出预览最大行数 */
const MAX_PREVIEW_LINES = 4

interface Props {
  events: ToolEvent[]
}

export function ToolHistoryBlock({ events }: Props) {
  if (events.length === 0) return null

  return (
    <div className="my-2 space-y-1">
      {events.map(e => (
        <ToolHistoryItem key={e.toolCallId} event={e} />
      ))}
    </div>
  )
}

function ToolHistoryItem({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded(prev => !prev), [])

  const name = DISPLAY_NAMES[event.toolName] ?? event.toolName
  const summary = argsSummary(event.toolName, event.args)
  const icon = event.success ? '✓' : event.success === false ? '✗' : '?'
  const iconColor = event.success ? 'text-green-400' : event.success === false ? 'text-red-400' : 'text-gray-400'
  const dur = event.durationMs != null ? `${event.durationMs}ms` : ''

  const hasOutput = Boolean(event.resultSummary?.trim())
  const outputLines = event.resultSummary?.split('\n') ?? []
  const previewLines = outputLines.slice(0, MAX_PREVIEW_LINES)
  const remaining = outputLines.length - previewLines.length

  return (
    <div className="text-sm">
      {/* 头部行：可点击折叠/展开 */}
      <button
        onClick={hasOutput ? toggle : undefined}
        className={`flex items-center gap-1.5 text-left w-full ${hasOutput ? 'cursor-pointer hover:bg-gray-800/50 rounded px-1 -mx-1' : ''}`}
      >
        <span className={iconColor}>{icon}</span>
        <span className="text-gray-300 font-medium">{name}</span>
        {summary && <span className="text-gray-500">({summary})</span>}
        {dur && <span className="text-gray-600 ml-1">{dur}</span>}
        {hasOutput && (
          <span className="text-gray-600 ml-1 text-xs">{expanded ? '▼' : '▶'}</span>
        )}
      </button>

      {/* 输出子块：⎿ 连接符 + 缩进内容 */}
      {hasOutput && expanded && (
        <div className="ml-4 mt-0.5 border-l-2 border-gray-700 pl-2">
          {previewLines.map((line, i) => (
            <pre key={i} className="text-xs text-gray-500 font-mono whitespace-pre-wrap">
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

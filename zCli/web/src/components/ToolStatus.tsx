// src/components/ToolStatus.tsx

import type { ToolEvent } from '../types.js'

interface Props {
  events: ToolEvent[]
}

/** 从 args 中提取关键参数作为摘要（模仿 CLI 的 ToolStatusLine） */
function formatArgsSummary(args: Record<string, unknown>): string {
  if (args['file_path']) return `(${args['file_path']})`
  if (args['path']) return `(${args['path']})`
  if (args['pattern']) return `(${args['pattern']})`
  if (args['command']) {
    const cmd = String(args['command'])
    return `(${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd})`
  }
  return ''
}

export function ToolStatus({ events }: Props) {
  if (events.length === 0) return null
  return (
    <div className="px-4 py-2 space-y-2">
      {events.map(e => (
        <div key={e.toolCallId} className="text-sm">
          {/* 工具头部：状态图标 + 名称 + 参数摘要 + 耗时 */}
          <div className="flex items-center gap-2 text-gray-400">
            <span className={
              e.status === 'running'
                ? 'animate-pulse text-yellow-400'
                : e.success ? 'text-green-400' : 'text-red-400'
            }>
              {e.status === 'running' ? '⟳' : e.success ? '✓' : '✗'}
            </span>
            <span className="font-mono">
              {e.toolName}{formatArgsSummary(e.args)}
            </span>
            {e.durationMs != null && (
              <span className="text-gray-500">{e.durationMs}ms</span>
            )}
          </div>

          {/* 结果子块：输出摘要 */}
          {e.resultSummary && (
            <div className="ml-6 mt-0.5 text-gray-500 border-l-2 border-gray-700 pl-2">
              <pre className="text-xs whitespace-pre-wrap font-mono">
                {e.resultSummary.length > 300
                  ? e.resultSummary.slice(0, 297) + '...'
                  : e.resultSummary}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

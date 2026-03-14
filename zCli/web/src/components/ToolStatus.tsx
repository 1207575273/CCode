// src/components/ToolStatus.tsx
import type { ToolEvent } from '../types.js'

interface Props {
  events: ToolEvent[]
}

export function ToolStatus({ events }: Props) {
  if (events.length === 0) return null
  return (
    <div className="px-4 py-2 space-y-1">
      {events.map(e => (
        <div key={e.toolCallId} className="flex items-center gap-2 text-sm text-gray-400">
          <span className={e.status === 'running' ? 'animate-pulse text-yellow-400' : e.success ? 'text-green-400' : 'text-red-400'}>
            {e.status === 'running' ? '⟳' : e.success ? '✓' : '✗'}
          </span>
          <span className="font-mono">{e.toolName}</span>
          {e.durationMs != null && <span className="text-gray-500">({e.durationMs}ms)</span>}
        </div>
      ))}
    </div>
  )
}

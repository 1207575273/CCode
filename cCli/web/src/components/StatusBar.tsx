// src/components/StatusBar.tsx

interface StatusBarData {
  sys: {
    memPercent: number
    memUsedBytes: number
    memTotalBytes: number
    cpuPercent: number
  }
  proc: {
    memPercent: number
    memUsedBytes: number
    cpuPercent: number
    elapsedMs: number
  }
  token: {
    inputTokens: number
    outputTokens: number
    costByCurrency: Record<string, number>
    callCount: number
  } | null
  context: {
    usedPercentage: number
    level: string
  } | null
}

interface StatusBarProps {
  data: StatusBarData | null
}

/** 进度条色阶 */
function barColorClass(percent: number): string {
  if (percent >= 85) return 'bg-red-500'
  if (percent >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

/** 格式化字节 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

/** 格式化时间 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(minutes)}:${pad(seconds)}`
}

/** 格式化 token 数量 */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** 进度条组件 */
function ProgressBar({ percent, width = 'w-20' }: { percent: number; width?: string }) {
  const clampedPercent = Math.min(100, Math.max(0, percent))
  return (
    <div className={`${width} h-2.5 bg-gray-700 rounded-sm overflow-hidden inline-flex`}>
      <div
        className={`h-full ${barColorClass(clampedPercent)} transition-all duration-300`}
        style={{ width: `${clampedPercent}%` }}
      />
    </div>
  )
}

export function StatusBar({ data }: StatusBarProps) {
  if (!data) return null

  const { sys, proc, token, context } = data

  return (
    <div className="px-4 py-1.5 text-xs text-gray-400 font-mono border-t border-gray-800 space-y-1">
      {/* SYS 行：系统整体资源 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-gray-500 w-10">SYS</span>
        <span className="flex items-center gap-1.5">
          <span>MEM</span>
          <ProgressBar percent={sys.memPercent} />
          <span>{Math.round(sys.memPercent)}%</span>
          <span className="text-gray-500">{formatBytes(sys.memUsedBytes)}/{formatBytes(sys.memTotalBytes)}</span>
        </span>
        <span className="text-gray-600">|</span>
        <span className="flex items-center gap-1.5">
          <span>CPU</span>
          <ProgressBar percent={sys.cpuPercent} />
          <span>{Math.round(sys.cpuPercent)}%</span>
        </span>
      </div>

      {/* PROC 行：进程资源 + 运行时信息 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-gray-500 w-10">PROC</span>
        <span className="flex items-center gap-1.5">
          <span>MEM</span>
          <ProgressBar percent={proc.memPercent} />
          <span>{Math.round(proc.memPercent)}%</span>
          <span className="text-gray-500">{formatBytes(proc.memUsedBytes)}</span>
        </span>
        <span className="text-gray-600">|</span>
        <span className="flex items-center gap-1.5">
          <span>CPU</span>
          <ProgressBar percent={proc.cpuPercent} />
          <span>{Math.round(proc.cpuPercent)}%</span>
        </span>
        <span className="text-gray-600">|</span>
        <span>⏱ {formatElapsed(proc.elapsedMs)}</span>
        {token && token.callCount > 0 && (
          <>
            <span className="text-gray-600">|</span>
            <span>{formatTokenCount(token.inputTokens)}/{formatTokenCount(token.outputTokens)} tok</span>
          </>
        )}
        {context && (
          <>
            <span className="text-gray-600">|</span>
            <span className={
              context.level === 'overflow' || context.level === 'critical' ? 'text-red-400'
              : context.level === 'warning' ? 'text-yellow-400'
              : ''
            }>
              Ctx {(context.usedPercentage * 100).toFixed(0)}%
            </span>
          </>
        )}
        {token && token.callCount > 0 && (() => {
          const sym = (c: string) => c === 'CNY' ? '¥' : '$'
          const parts = Object.entries(token.costByCurrency)
            .filter(([, v]) => v > 0)
            .map(([c, v]) => `${sym(c)}${v.toFixed(4)}`)
          if (parts.length === 0) return null
          return (
            <>
              <span className="text-gray-600">|</span>
              <span>{parts.join('+')}</span>
            </>
          )
        })()}
      </div>
    </div>
  )
}

export type { StatusBarData }

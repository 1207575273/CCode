// web/src/components/StatusBar.tsx

/**
 * StatusBar — Web 端底部状态栏（三行布局，与 CLI 端保持一致）。
 *
 * 布局：
 *   SYS  MEM [████░░░░] 62% 10.2/16GB | CPU [████░░░░] 45%
 *   PROC MEM [████░░░░]  3%  256MB    | CPU [████░░░░]  8%
 *   INFO ⏱ 03:25 | 1.2K/800 tok | Ctx 65% | $0.02
 *
 * 数据来源：CLI 通过 eventBus → Bridge Server → WebSocket 推送 status_bar 事件。
 * 运行时间由本地 1s interval 平滑补偿（见 ChatPage.tsx）。
 */

// ═══════════════════════════════════════════════
// 类型（与 CLI 端 StatusBarPayload 对齐）
// ═══════════════════════════════════════════════

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

// ═══════════════════════════════════════════════
// 格式化函数
// ═══════════════════════════════════════════════

/** 进度条色阶：0-60% 绿、60-85% 黄、85%+ 红 */
function barColorClass(percent: number): string {
  if (percent >= 85) return 'bg-red-500'
  if (percent >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

/** 格式化字节为 MB/GB，负数兜底为 0MB */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0MB'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

/** 格式化毫秒为 MM:SS 或 HH:MM:SS，负数兜底为 00:00 */
function formatElapsed(ms: number): string {
  if (ms <= 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(minutes)}:${pad(seconds)}`
}

/** 格式化 token 数值（K/M 自动缩写） */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

// ═══════════════════════════════════════════════
// 子组件
// ═══════════════════════════════════════════════

/** CSS 进度条（Tailwind 实现） */
function ProgressBar({ percent, width = 'w-20' }: { percent: number; width?: string }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className={`${width} h-2.5 bg-gray-700 rounded-sm overflow-hidden inline-flex`}>
      <div
        className={`h-full ${barColorClass(clamped)} transition-all duration-300`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** 分隔符 */
function Sep() {
  return <span className="text-gray-600">|</span>
}

// ═══════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════

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
        <Sep />
        <span className="flex items-center gap-1.5">
          <span>CPU</span>
          <ProgressBar percent={sys.cpuPercent} />
          <span>{Math.round(sys.cpuPercent)}%</span>
        </span>
      </div>

      {/* PROC 行：进程资源 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-gray-500 w-10">PROC</span>
        <span className="flex items-center gap-1.5">
          <span>MEM</span>
          <ProgressBar percent={proc.memPercent} />
          <span>{Math.round(proc.memPercent)}%</span>
          <span className="text-gray-500">{formatBytes(proc.memUsedBytes)}</span>
        </span>
        <Sep />
        <span className="flex items-center gap-1.5">
          <span>CPU</span>
          <ProgressBar percent={proc.cpuPercent} />
          <span>{Math.round(proc.cpuPercent)}%</span>
        </span>
      </div>

      {/* INFO 行：运行时间 + token + context + cost */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-gray-500 w-10">INFO</span>
        <span>⏱ {formatElapsed(proc.elapsedMs)}</span>
        {token && token.callCount > 0 && (
          <>
            <Sep />
            <span>{formatTokenCount(token.inputTokens)}/{formatTokenCount(token.outputTokens)} tok</span>
          </>
        )}
        {context && (
          <>
            <Sep />
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
              <Sep />
              <span>{parts.join('+')}</span>
            </>
          )
        })()}
      </div>
    </div>
  )
}

export type { StatusBarData }

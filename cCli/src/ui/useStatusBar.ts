// src/ui/useStatusBar.ts

/**
 * useStatusBar — 状态栏数据采集 hook。
 *
 * 职责：
 * - 定时采集 MEM（process.memoryUsage().rss / os.totalmem()）和 CPU（process.cpuUsage() 差值采样）
 * - 每秒更新运行时间（accumulatedMs + 本次运行时长）
 * - 输出 StatusBarData 供 StatusBar.tsx 渲染
 */

import { useState, useEffect, useRef } from 'react'
import { totalmem, cpus } from 'node:os'

/** 资源采样间隔 */
const RESOURCE_INTERVAL_MS = 3000
/** 运行时间刷新间隔 */
const ELAPSED_INTERVAL_MS = 1000

/** 进度条色阶阈值 */
export const THRESHOLD_WARNING = 60
export const THRESHOLD_CRITICAL = 85

/** 进度条默认宽度 */
export const BAR_WIDTH = 8

export interface StatusBarData {
  memPercent: number
  memUsedBytes: number
  memTotalBytes: number
  cpuPercent: number
  cpuCoreCount: number
  elapsedMs: number
}

interface UseStatusBarOptions {
  /** 是否有消息（没消息时不采集） */
  hasMessages: boolean
  /** 历史累计时长（resume 带入） */
  accumulatedMs: number
  /** 本次 session 启动时间戳 */
  sessionStartTime: number
}

export function useStatusBar(options: UseStatusBarOptions): StatusBarData | null {
  const { hasMessages, accumulatedMs, sessionStartTime } = options

  const [data, setData] = useState<StatusBarData | null>(null)
  const prevCpuUsageRef = useRef<NodeJS.CpuUsage | null>(null)
  const prevCpuTimeRef = useRef<number>(0)

  // 系统常量（进程生命周期内不变）
  const totalMemRef = useRef(totalmem())
  const cpuCountRef = useRef(cpus().length)

  // ── 资源采样（MEM + CPU），每 3 秒 ──
  useEffect(() => {
    if (!hasMessages) return

    const sample = () => {
      const rss = process.memoryUsage().rss
      const totalMem = totalMemRef.current
      const memPercent = totalMem > 0 ? (rss / totalMem) * 100 : 0

      let cpuPercent = 0
      const now = Date.now()
      const currentCpu = process.cpuUsage()

      if (prevCpuUsageRef.current && prevCpuTimeRef.current > 0) {
        const elapsedMs = now - prevCpuTimeRef.current
        if (elapsedMs > 0) {
          const userDelta = currentCpu.user - prevCpuUsageRef.current.user
          const systemDelta = currentCpu.system - prevCpuUsageRef.current.system
          const totalCpuUs = userDelta + systemDelta
          const elapsedUs = elapsedMs * 1000
          cpuPercent = (totalCpuUs / elapsedUs / cpuCountRef.current) * 100
        }
      }

      prevCpuUsageRef.current = currentCpu
      prevCpuTimeRef.current = now

      setData(prev => {
        const elapsed = accumulatedMs + (Date.now() - sessionStartTime)
        const next: StatusBarData = {
          memPercent,
          memUsedBytes: rss,
          memTotalBytes: totalMem,
          cpuPercent: Math.min(100, Math.max(0, cpuPercent)),
          cpuCoreCount: cpuCountRef.current,
          elapsedMs: elapsed,
        }
        if (prev &&
            Math.abs(prev.memPercent - next.memPercent) < 0.1 &&
            Math.abs(prev.cpuPercent - next.cpuPercent) < 0.1 &&
            prev.elapsedMs === next.elapsedMs) {
          return prev
        }
        return next
      })
    }

    sample()
    const id = setInterval(sample, RESOURCE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hasMessages, accumulatedMs, sessionStartTime])

  // ── 运行时间，每 1 秒 ──
  useEffect(() => {
    if (!hasMessages) return

    const tick = () => {
      setData(prev => {
        if (!prev) return prev
        return { ...prev, elapsedMs: accumulatedMs + (Date.now() - sessionStartTime) }
      })
    }

    const id = setInterval(tick, ELAPSED_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hasMessages, accumulatedMs, sessionStartTime])

  if (!hasMessages) return null
  return data
}

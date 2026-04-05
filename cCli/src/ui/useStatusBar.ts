// src/ui/useStatusBar.ts

/**
 * useStatusBar — 状态栏数据采集 hook。
 *
 * 职责：
 * - 定时采集系统 MEM（os.freemem）和系统 CPU（os.cpus 差值采样）
 * - 定时采集进程 MEM（process.memoryUsage().rss）和进程 CPU（process.cpuUsage() 差值采样）
 * - 每秒更新运行时间（accumulatedMs + 本次运行时长）
 * - 通过 eventBus 推送 status_bar 事件（供 Web 端消费）
 * - 输出 StatusBarData 供 StatusBar.tsx 渲染
 */

import { useState, useEffect, useRef } from 'react'
import { totalmem, freemem, cpus } from 'node:os'
import { eventBus } from '@core/event-bus.js'
import type { StatusBarPayload } from '@core/event-bus.js'

/** 资源采样间隔 */
const RESOURCE_INTERVAL_MS = 3000
/** 运行时间刷新间隔 */
const ELAPSED_INTERVAL_MS = 1000

/** 进度条色阶阈值 */
export const THRESHOLD_WARNING = 60
export const THRESHOLD_CRITICAL = 85

/** 进度条默认宽度 */
export const BAR_WIDTH = 10

export interface StatusBarData {
  // SYS 行
  sysMemPercent: number
  sysMemUsedBytes: number
  sysMemTotalBytes: number
  sysCpuPercent: number
  // PROC 行
  procMemPercent: number
  procMemUsedBytes: number
  procCpuPercent: number
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

/** 采集所有 CPU 核心的 idle/total 时间（用于系统 CPU 使用率差值计算） */
export function sampleCpuTimes(): { idle: number; total: number } {
  const cpuList = cpus()
  let idle = 0, total = 0
  for (const cpu of cpuList) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
  }
  return { idle, total }
}

export function useStatusBar(options: UseStatusBarOptions): StatusBarData | null {
  const { hasMessages, accumulatedMs, sessionStartTime } = options

  const [data, setData] = useState<StatusBarData | null>(null)
  const prevCpuUsageRef = useRef<NodeJS.CpuUsage | null>(null)
  const prevCpuTimeRef = useRef<number>(0)
  const prevSysCpuRef = useRef<{ idle: number; total: number } | null>(null)

  // 系统常量（进程生命周期内不变）
  const totalMemRef = useRef(totalmem())
  const cpuCountRef = useRef(cpus().length)

  // ── 资源采样（SYS + PROC MEM/CPU），每 3 秒 ──
  useEffect(() => {
    if (!hasMessages) return

    const sample = () => {
      const totalMem = totalMemRef.current
      const coreCount = cpuCountRef.current

      // ── SYS MEM ──
      const sysUsedMem = totalMem - freemem()
      const sysMemPercent = totalMem > 0 ? (sysUsedMem / totalMem) * 100 : 0

      // ── SYS CPU（os.cpus 差值） ──
      let sysCpuPercent = 0
      const currentSysCpu = sampleCpuTimes()
      if (prevSysCpuRef.current) {
        const idleDelta = currentSysCpu.idle - prevSysCpuRef.current.idle
        const totalDelta = currentSysCpu.total - prevSysCpuRef.current.total
        sysCpuPercent = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0
      }
      prevSysCpuRef.current = currentSysCpu

      // ── PROC MEM ──
      const rss = process.memoryUsage().rss
      const procMemPercent = totalMem > 0 ? (rss / totalMem) * 100 : 0

      // ── PROC CPU（process.cpuUsage 差值） ──
      let procCpuPercent = 0
      const now = Date.now()
      const currentCpu = process.cpuUsage()
      if (prevCpuUsageRef.current && prevCpuTimeRef.current > 0) {
        const elapsedMs = now - prevCpuTimeRef.current
        if (elapsedMs > 0) {
          const userDelta = currentCpu.user - prevCpuUsageRef.current.user
          const systemDelta = currentCpu.system - prevCpuUsageRef.current.system
          const totalCpuUs = userDelta + systemDelta
          const elapsedUs = elapsedMs * 1000
          procCpuPercent = (totalCpuUs / elapsedUs / coreCount) * 100
        }
      }
      prevCpuUsageRef.current = currentCpu
      prevCpuTimeRef.current = now

      const elapsed = accumulatedMs + (Date.now() - sessionStartTime)
      const clamp = (v: number) => Math.min(100, Math.max(0, v))

      const next: StatusBarData = {
        sysMemPercent: clamp(sysMemPercent),
        sysMemUsedBytes: sysUsedMem,
        sysMemTotalBytes: totalMem,
        sysCpuPercent: clamp(sysCpuPercent),
        procMemPercent: clamp(procMemPercent),
        procMemUsedBytes: rss,
        procCpuPercent: clamp(procCpuPercent),
        cpuCoreCount: coreCount,
        elapsedMs: elapsed,
      }

      setData(next)

      // eventBus 推送（Web 端消费）
      const payload: StatusBarPayload = {
        sys: {
          memPercent: next.sysMemPercent,
          memUsedBytes: next.sysMemUsedBytes,
          memTotalBytes: next.sysMemTotalBytes,
          cpuPercent: next.sysCpuPercent,
        },
        proc: {
          memPercent: next.procMemPercent,
          memUsedBytes: next.procMemUsedBytes,
          cpuPercent: next.procCpuPercent,
          elapsedMs: next.elapsedMs,
        },
        token: null,
        context: null,
      }
      eventBus.emit({ type: 'status_bar', data: payload })
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

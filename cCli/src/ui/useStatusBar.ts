// src/ui/useStatusBar.ts

/**
 * useStatusBar — 状态栏数据采集 hook。
 *
 * 职责：
 * - 定时采集系统级资源：MEM（os.freemem）、CPU（os.cpus 差值采样）
 * - 定时采集进程级资源：MEM（process.memoryUsage().rss）、CPU（process.cpuUsage 差值采样）
 * - 每秒更新运行时间（accumulatedMs + 本次运行时长）
 * - 通过 eventBus 推送 status_bar 事件供 Web 端消费
 * - 输出 StatusBarData 供 CLI StatusBar.tsx 渲染
 *
 * 设计要点：
 * - 两个独立 setInterval：资源采样 3s + 时间刷新 1s，避免 3s 才跳一次秒
 * - getTokenStats / getContextState 通过 ref 持有最新引用，避免闭包陈旧
 * - 所有采样调用 try-catch 兜底，极端内存压力下不崩溃
 * - clamp(0, 100) 防止计算溢出产生无意义百分比
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { totalmem, freemem, cpus } from 'node:os'
import { eventBus } from '@core/event-bus.js'
import type { StatusBarPayload } from '@core/event-bus.js'

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 资源采样间隔（MEM + CPU） */
const RESOURCE_INTERVAL_MS = 3000
/** 运行时间刷新间隔 */
const ELAPSED_INTERVAL_MS = 1000

/** 进度条色阶阈值（百分比） */
export const THRESHOLD_WARNING = 60
export const THRESHOLD_CRITICAL = 85

/** 进度条字符宽度（SYS/PROC 行对齐，CLI 端使用） */
export const BAR_WIDTH = 10

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

/** StatusBar 展示数据（CLI 端 StatusBar.tsx 消费） */
export interface StatusBarData {
  /** 系统内存使用率 (%) */
  sysMemPercent: number
  /** 系统已用内存 (bytes) */
  sysMemUsedBytes: number
  /** 系统总内存 (bytes) */
  sysMemTotalBytes: number
  /** 系统 CPU 使用率 (%)，全核心加权 */
  sysCpuPercent: number
  /** 进程内存使用率 (%) = rss / totalmem */
  procMemPercent: number
  /** 进程 RSS (bytes) */
  procMemUsedBytes: number
  /** 进程 CPU 使用率 (%)，全核心加权 */
  procCpuPercent: number
  /** CPU 核心数（展示用） */
  cpuCoreCount: number
  /** 累计运行时间 (ms)，含跨 resume 历史 */
  elapsedMs: number
}

/** Token 统计快照（用于 eventBus 推送） */
interface TokenSnapshot {
  totalInputTokens: number
  totalOutputTokens: number
  costByCurrency: Record<string, number>
  callCount: number
}

/** Context 状态快照（用于 eventBus 推送） */
interface ContextSnapshot {
  usedPercentage: number
  level: string
}

interface UseStatusBarOptions {
  /** 是否启用（false 时不采集、不推送、不启动定时器，零开销） */
  enabled: boolean
  /** 历史累计运行时长 ms（resume 时从 JSONL 恢复） */
  accumulatedMs: number
  /** 本次 session 启动时间戳（Date.now()） */
  sessionStartTime: number
  /** 获取当前 token 统计（eventBus 推送用，每 3s 调用一次） */
  getTokenStats?: () => TokenSnapshot | null
  /** 获取当前 context 状态（eventBus 推送用，每 3s 调用一次） */
  getContextState?: () => ContextSnapshot | null
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

/**
 * 采集所有 CPU 核心的 idle/total 累计时间。
 * 连续两次采样的差值可计算出系统 CPU 使用率。
 * 算法与 htop 一致：usage% = (totalDelta - idleDelta) / totalDelta
 */
export function sampleCpuTimes(): { idle: number; total: number } {
  const cpuList = cpus()
  let idle = 0, total = 0
  for (const cpu of cpuList) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { idle, total }
}

/** 将数值钳位到 [0, 100] 范围 */
function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0  // 防御 NaN / Infinity
  return Math.min(100, Math.max(0, v))
}

// ═══════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════

export function useStatusBar(options: UseStatusBarOptions): StatusBarData | null {
  const { enabled, accumulatedMs, sessionStartTime } = options

  const [data, setData] = useState<StatusBarData | null>(null)

  // ── CPU 差值采样前值 ──
  const prevProcCpuRef = useRef<NodeJS.CpuUsage | null>(null)
  const prevProcCpuTimeRef = useRef<number>(0)
  const prevSysCpuRef = useRef<{ idle: number; total: number } | null>(null)

  // ── 系统常量（进程生命周期内不变，避免重复系统调用） ──
  const totalMemRef = useRef(totalmem())
  const cpuCountRef = useRef(cpus().length || 1)  // 兜底至少 1 核，防止除零

  // ── 回调用 ref 持有最新引用，避免 setInterval 闭包陈旧 ──
  const getTokenStatsRef = useRef(options.getTokenStats)
  const getContextStateRef = useRef(options.getContextState)
  getTokenStatsRef.current = options.getTokenStats
  getContextStateRef.current = options.getContextState

  // accumulatedMs / sessionStartTime 也用 ref，确保 interval 内读到最新值
  const accumulatedMsRef = useRef(accumulatedMs)
  const sessionStartTimeRef = useRef(sessionStartTime)
  accumulatedMsRef.current = accumulatedMs
  sessionStartTimeRef.current = sessionStartTime

  // ── 资源采样（SYS + PROC），每 RESOURCE_INTERVAL_MS 执行 ──
  const sample = useCallback(() => {
    try {
      const totalMem = totalMemRef.current
      const coreCount = cpuCountRef.current

      // ── SYS MEM ──
      const free = freemem()
      // 防御：freemem 在极端情况下可能大于缓存的 totalmem（内存热插拔、虚拟化环境）
      const sysUsedMem = Math.max(0, totalMem - free)
      const sysMemPercent = totalMem > 0 ? (sysUsedMem / totalMem) * 100 : 0

      // ── SYS CPU（os.cpus 两次采样差值） ──
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

      // ── PROC CPU（process.cpuUsage 两次采样差值，微秒精度） ──
      let procCpuPercent = 0
      const now = Date.now()
      const currentCpu = process.cpuUsage()
      if (prevProcCpuRef.current && prevProcCpuTimeRef.current > 0) {
        const elapsedMs = now - prevProcCpuTimeRef.current
        if (elapsedMs > 0) {
          const userDelta = currentCpu.user - prevProcCpuRef.current.user
          const systemDelta = currentCpu.system - prevProcCpuRef.current.system
          const totalCpuUs = userDelta + systemDelta
          const elapsedUs = elapsedMs * 1000
          procCpuPercent = (totalCpuUs / elapsedUs / coreCount) * 100
        }
      }
      prevProcCpuRef.current = currentCpu
      prevProcCpuTimeRef.current = now

      const elapsed = accumulatedMsRef.current + (Date.now() - sessionStartTimeRef.current)

      const next: StatusBarData = {
        sysMemPercent: clamp100(sysMemPercent),
        sysMemUsedBytes: sysUsedMem,
        sysMemTotalBytes: totalMem,
        sysCpuPercent: clamp100(sysCpuPercent),
        procMemPercent: clamp100(procMemPercent),
        procMemUsedBytes: rss,
        procCpuPercent: clamp100(procCpuPercent),
        cpuCoreCount: coreCount,
        elapsedMs: elapsed,
      }

      setData(next)

      // ── eventBus 推送（Web 端 StatusBar 消费） ──
      const tokenStats = getTokenStatsRef.current?.() ?? null
      const ctxState = getContextStateRef.current?.() ?? null
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
        token: tokenStats && tokenStats.callCount > 0 ? {
          inputTokens: tokenStats.totalInputTokens,
          outputTokens: tokenStats.totalOutputTokens,
          costByCurrency: tokenStats.costByCurrency,
          callCount: tokenStats.callCount,
        } : null,
        context: ctxState ? {
          usedPercentage: ctxState.usedPercentage,
          level: ctxState.level,
        } : null,
      }
      eventBus.emit({ type: 'status_bar', data: payload })

    } catch {
      // 采样失败不阻断 UI，静默跳过本次（下次 interval 重试）
      // 典型场景：极端内存压力下 process.memoryUsage() 或 os.freemem() 可能抛异常
    }
  }, [])  // 无外部依赖，所有变量通过 ref 访问

  useEffect(() => {
    if (!enabled) return

    // 立即采样一次（不等第一个 interval）
    sample()
    const id = setInterval(sample, RESOURCE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled, sample])

  // ── 运行时间，每秒刷新（秒表感） ──
  useEffect(() => {
    if (!enabled) return

    const tick = () => {
      setData(prev => {
        if (!prev) return prev
        return { ...prev, elapsedMs: accumulatedMsRef.current + (Date.now() - sessionStartTimeRef.current) }
      })
    }

    const id = setInterval(tick, ELAPSED_INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled])

  if (!enabled) return null
  return data
}

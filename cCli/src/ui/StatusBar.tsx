// src/ui/StatusBar.tsx

/**
 * StatusBar — 统一底部状态栏（三行布局）。
 *
 * 布局：
 *   SYS  MEM ██████████ 62% 10.2/16GB | CPU ██████████ 45%
 *   PROC MEM ██████████  3%  256MB    | CPU ██████████  8%
 *   INFO ⏱ 03:25 | 1.2K/800 tok | Ctx 65% | $0.02
 *
 * 设计要点：
 * - 纯展示组件，所有数据由 props 注入，无副作用
 * - 一启动就展示 SYS/PROC/INFO 三行，token/context 空时 INFO 行只显示运行时间
 * - 窄终端自适应：每行独立从右向左截断，保证核心指标始终可见
 * - 所有格式化函数导出供单元测试使用
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { StatusBarData } from './useStatusBar.js'
import { BAR_WIDTH, THRESHOLD_WARNING, THRESHOLD_CRITICAL } from './useStatusBar.js'
import type { SessionCostStats } from '@observability/token-meter.js'
import type { ContextWindowState } from '@core/context-tracker.js'

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

interface StatusBarProps {
  /** 采集数据（null 时整个 StatusBar 不渲染） */
  data: StatusBarData | null
  /** Token 用量统计（来自 TokenMeter，LLM 调用后才有值） */
  tokenStats: SessionCostStats | null
  /** 上下文窗口状态（来自 contextTracker，LLM 调用后才有值） */
  contextState: ContextWindowState | null
  /** 终端宽度，用于截断计算 */
  terminalWidth: number
}

/** 单个指标段：key 用于 React key，width 用于截断计算，render 用于渲染 */
interface Segment {
  key: string
  /** 预估纯文本渲染宽度（字符数），用于窄终端截断判断 */
  width: number
  render: () => React.ReactNode
}

// ═══════════════════════════════════════════════
// 格式化函数（导出供测试使用）
// ═══════════════════════════════════════════════

/**
 * 渲染终端进度条。
 * @param percent 百分比（0-100），超出范围会 clamp
 * @param width 进度条字符宽度
 * @returns 如 "████░░░░░░"
 */
function renderBar(percent: number, width: number): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = width - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

/**
 * 根据百分比返回色阶颜色（绿/黄/红）。
 * 阈值：0-60% 绿色、60-85% 黄色、85%+ 红色
 */
function barColor(percent: number): 'red' | 'yellow' | 'green' {
  if (percent >= THRESHOLD_CRITICAL) return 'red'
  if (percent >= THRESHOLD_WARNING) return 'yellow'
  return 'green'
}

/** 格式化字节为人类可读（MB/GB），负数兜底为 0MB */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0MB'
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  }
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
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  }
  return `${pad(minutes)}:${pad(seconds)}`
}

/** 格式化 token 数值（K/M 自动缩写） */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

// ═══════════════════════════════════════════════
// 段落构建
// ═══════════════════════════════════════════════

/** SYS 行：系统级 MEM + CPU */
function buildSysSegments(data: StatusBarData): Segment[] {
  const segments: Segment[] = []

  // 系统内存：进度条 + 百分比 + 已用/总量
  const memBar = renderBar(data.sysMemPercent, BAR_WIDTH)
  const memPct = `${Math.round(data.sysMemPercent)}%`.padStart(4)
  const memUsed = formatBytes(data.sysMemUsedBytes)
  const memTotal = formatBytes(data.sysMemTotalBytes)
  const memText = `MEM ${memBar} ${memPct} ${memUsed}/${memTotal}`
  segments.push({
    key: 'sys-mem',
    width: memText.length,
    render: () => (
      <Text>
        <Text dimColor>MEM </Text>
        <Text color={barColor(data.sysMemPercent)}>{memBar}</Text>
        <Text dimColor> {memPct} {memUsed}/{memTotal}</Text>
      </Text>
    ),
  })

  // 系统 CPU：进度条 + 百分比
  const cpuBar = renderBar(data.sysCpuPercent, BAR_WIDTH)
  const cpuPct = `${Math.round(data.sysCpuPercent)}%`.padStart(4)
  const cpuText = `CPU ${cpuBar} ${cpuPct}`
  segments.push({
    key: 'sys-cpu',
    width: cpuText.length,
    render: () => (
      <Text>
        <Text dimColor>CPU </Text>
        <Text color={barColor(data.sysCpuPercent)}>{cpuBar}</Text>
        <Text dimColor> {cpuPct}</Text>
      </Text>
    ),
  })

  return segments
}

/** PROC 行：进程级 MEM + CPU */
function buildProcSegments(data: StatusBarData): Segment[] {
  const segments: Segment[] = []

  // 进程内存：进度条 + 百分比 + RSS 绝对值
  const memBar = renderBar(data.procMemPercent, BAR_WIDTH)
  const memPct = `${Math.round(data.procMemPercent)}%`.padStart(4)
  const memAbs = formatBytes(data.procMemUsedBytes)
  const memText = `MEM ${memBar} ${memPct} ${memAbs}`
  segments.push({
    key: 'proc-mem',
    width: memText.length,
    render: () => (
      <Text>
        <Text dimColor>MEM </Text>
        <Text color={barColor(data.procMemPercent)}>{memBar}</Text>
        <Text dimColor> {memPct} {memAbs}</Text>
      </Text>
    ),
  })

  // 进程 CPU：进度条 + 百分比
  const cpuBar = renderBar(data.procCpuPercent, BAR_WIDTH)
  const cpuPct = `${Math.round(data.procCpuPercent)}%`.padStart(4)
  const cpuText = `CPU ${cpuBar} ${cpuPct}`
  segments.push({
    key: 'proc-cpu',
    width: cpuText.length,
    render: () => (
      <Text>
        <Text dimColor>CPU </Text>
        <Text color={barColor(data.procCpuPercent)}>{cpuBar}</Text>
        <Text dimColor> {cpuPct}</Text>
      </Text>
    ),
  })

  return segments
}

/** INFO 行：运行时间 + token + context + cost（按出现顺序排列） */
function buildInfoSegments(
  data: StatusBarData,
  tokenStats: SessionCostStats | null,
  contextState: ContextWindowState | null,
): Segment[] {
  const segments: Segment[] = []

  // 运行时间（始终显示，是 INFO 行的锚点）
  const elapsed = formatElapsed(data.elapsedMs)
  segments.push({
    key: 'elapsed',
    width: elapsed.length + 3,  // "⏱ " 前缀占 2 宽字符 + 1 空格
    render: () => <Text dimColor>⏱ {elapsed}</Text>,
  })

  // Token 统计（首次 LLM 调用后才显示）
  if (tokenStats && tokenStats.callCount > 0) {
    const tokIn = formatTokenCount(tokenStats.totalInputTokens)
    const tokOut = formatTokenCount(tokenStats.totalOutputTokens)
    const tokText = `${tokIn}/${tokOut} tok`
    segments.push({
      key: 'token',
      width: tokText.length,
      render: () => <Text dimColor>{tokText}</Text>,
    })
  }

  // Context 窗口使用率（首次 LLM 调用后才有 inputTokens）
  if (contextState && contextState.lastInputTokens > 0) {
    const ctxPct = `${(contextState.usedPercentage * 100).toFixed(0)}%`
    const ctxText = `Ctx ${ctxPct}`
    const ctxColor = contextState.level === 'overflow' || contextState.level === 'critical'
      ? 'red' as const
      : contextState.level === 'warning'
        ? 'yellow' as const
        : undefined
    segments.push({
      key: 'context',
      width: ctxText.length,
      render: () => (
        <Text {...(ctxColor ? { color: ctxColor } : { dimColor: true })}>
          {ctxText}
        </Text>
      ),
    })
  }

  // 费用（有实际产生费用时才显示）
  if (tokenStats && tokenStats.callCount > 0) {
    const sym = (c: string) => c === 'CNY' ? '¥' : '$'
    const costParts = Object.entries(tokenStats.costByCurrency)
      .filter(([, v]) => v > 0)
      .map(([c, v]) => `${sym(c)}${v.toFixed(4)}`)
    if (costParts.length > 0) {
      const costText = costParts.join('+')
      segments.push({
        key: 'cost',
        width: costText.length,
        render: () => <Text dimColor>{costText}</Text>,
      })
    }
  }

  return segments
}

// ═══════════════════════════════════════════════
// 渲染辅助
// ═══════════════════════════════════════════════

/** 分隔符 */
const SEPARATOR = ' | '

/**
 * 按最大宽度截断段落列表。
 * 从左到右累加每段宽度，超出 maxWidth 时丢弃后续段落。
 * 保证至少保留第一个段落（即使超宽）。
 */
function truncateSegments(segments: Segment[], maxWidth: number): Segment[] {
  const visible: Segment[] = []
  let totalWidth = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg) break
    const segWidth = seg.width + (i > 0 ? SEPARATOR.length : 0)
    if (i > 0 && totalWidth + segWidth > maxWidth) break  // 第一段始终保留
    visible.push(seg)
    totalWidth += segWidth
  }
  return visible
}

/** 渲染单行：前缀标签 + 段落列表（带分隔符） */
function renderLine(segments: Segment[], prefix: string): React.ReactNode {
  if (segments.length === 0) return null
  return (
    <Box paddingX={1}>
      <Text dimColor>{prefix}</Text>
      {segments.map((seg, i) => (
        <React.Fragment key={seg.key}>
          {i > 0 && <Text dimColor>{SEPARATOR}</Text>}
          {seg.render()}
        </React.Fragment>
      ))}
    </Box>
  )
}

// ═══════════════════════════════════════════════
// 组件
// ═══════════════════════════════════════════════

export function StatusBar({ data, tokenStats, contextState, terminalWidth }: StatusBarProps): React.ReactNode {
  if (!data) return null

  // 前缀宽度 5 字符（"SYS  " / "PROC " / "INFO "）+ paddingX 各 1
  const maxWidth = terminalWidth - 2 - 5

  const sysSegments = truncateSegments(buildSysSegments(data), maxWidth)
  const procSegments = truncateSegments(buildProcSegments(data), maxWidth)
  const infoSegments = truncateSegments(buildInfoSegments(data, tokenStats, contextState), maxWidth)

  if (sysSegments.length === 0 && procSegments.length === 0 && infoSegments.length === 0) return null

  return (
    <Box flexDirection="column">
      {renderLine(sysSegments, 'SYS  ')}
      {renderLine(procSegments, 'PROC ')}
      {renderLine(infoSegments, 'INFO ')}
    </Box>
  )
}

// 导出供测试使用
export { renderBar, barColor, formatBytes, formatElapsed, formatTokenCount }

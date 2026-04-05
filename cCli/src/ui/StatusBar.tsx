// src/ui/StatusBar.tsx

/**
 * StatusBar — 统一底部状态栏。
 *
 * InputBar 下方固定一行，展示系统资源 + token/context/cost。
 * 纯展示组件，所有数据由 props 注入。
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { StatusBarData } from './useStatusBar.js'
import { BAR_WIDTH, THRESHOLD_WARNING, THRESHOLD_CRITICAL } from './useStatusBar.js'
import type { SessionCostStats } from '@observability/token-meter.js'
import type { ContextWindowState } from '@core/context-tracker.js'

interface StatusBarProps {
  data: StatusBarData | null
  tokenStats: SessionCostStats | null
  contextState: ContextWindowState | null
  terminalWidth: number
}

/** 渲染进度条 */
function renderBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

/** 根据百分比返回色阶颜色 */
function barColor(percent: number): 'red' | 'yellow' | 'green' {
  if (percent >= THRESHOLD_CRITICAL) return 'red'
  if (percent >= THRESHOLD_WARNING) return 'yellow'
  return 'green'
}

/** 格式化字节为人类可读 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

/** 格式化毫秒为 MM:SS 或 HH:MM:SS */
function formatElapsed(ms: number): string {
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

/** 格式化 token 数值（K/M 缩写） */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** 各指标段的渲染定义 */
interface Segment {
  key: string
  width: number
  render: () => React.ReactNode
}

function buildSegments(
  data: StatusBarData,
  tokenStats: SessionCostStats | null,
  contextState: ContextWindowState | null,
): Segment[] {
  const segments: Segment[] = []

  // MEM
  const memBar = renderBar(data.memPercent, BAR_WIDTH)
  const memPct = `${Math.round(data.memPercent)}%`
  const memAbs = formatBytes(data.memUsedBytes)
  const memText = `MEM ${memBar} ${memPct} ${memAbs}`
  segments.push({
    key: 'mem',
    width: memText.length,
    render: () => (
      <Text>
        <Text dimColor>MEM </Text>
        <Text color={barColor(data.memPercent)}>{memBar}</Text>
        <Text dimColor> {memPct} {memAbs}</Text>
      </Text>
    ),
  })

  // CPU
  const cpuBar = renderBar(data.cpuPercent, BAR_WIDTH)
  const cpuPct = `${Math.round(data.cpuPercent)}%`
  const cpuText = `CPU ${cpuBar} ${cpuPct}`
  segments.push({
    key: 'cpu',
    width: cpuText.length,
    render: () => (
      <Text>
        <Text dimColor>CPU </Text>
        <Text color={barColor(data.cpuPercent)}>{cpuBar}</Text>
        <Text dimColor> {cpuPct}</Text>
      </Text>
    ),
  })

  // Elapsed
  const elapsed = formatElapsed(data.elapsedMs)
  const elapsedText = `⏱ ${elapsed}`
  segments.push({
    key: 'elapsed',
    width: elapsedText.length + 1,
    render: () => <Text dimColor>⏱ {elapsed}</Text>,
  })

  // Token（仅在有调用时显示）
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

  // Context（仅在有数据时显示）
  if (contextState && contextState.lastInputTokens > 0) {
    const ctxPct = `${(contextState.usedPercentage * 100).toFixed(0)}%`
    const ctxText = `Ctx ${ctxPct}`
    const ctxColor = contextState.level === 'overflow' || contextState.level === 'critical'
      ? 'red'
      : contextState.level === 'warning'
        ? 'yellow'
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

  // Cost（仅在有费用时显示）
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

export function StatusBar({ data, tokenStats, contextState, terminalWidth }: StatusBarProps): React.ReactNode {
  if (!data) return null

  const segments = buildSegments(data, tokenStats, contextState)
  const separator = ' | '
  const separatorWidth = separator.length

  // 窄终端截断：从左到右累加宽度，超出时截断
  const maxWidth = terminalWidth - 2
  const visible: Segment[] = []
  let totalWidth = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg) break
    const segWidth = seg.width + (i > 0 ? separatorWidth : 0)
    if (totalWidth + segWidth > maxWidth) break
    visible.push(seg)
    totalWidth += segWidth
  }

  if (visible.length === 0) return null

  return (
    <Box paddingX={1}>
      {visible.map((seg, i) => (
        <React.Fragment key={seg.key}>
          {i > 0 && <Text dimColor>{separator}</Text>}
          {seg.render()}
        </React.Fragment>
      ))}
    </Box>
  )
}

// 导出供测试使用
export { renderBar, barColor, formatBytes, formatElapsed, formatTokenCount }

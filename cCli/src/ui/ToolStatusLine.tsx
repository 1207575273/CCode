// src/ui/ToolStatusLine.tsx

/**
 * ToolStatusLine — 单条工具执行状态行。
 *
 * 对标 Claude Code 的工具显示哲学：
 *   头部行：  ● Bash(cd "/tmp" && mvn compile)
 *   输出块：  ⎿  [INFO] BUILD SUCCESS
 *             ... +15 lines (ctrl+o to expand)
 *
 * 三态渲染：
 *   - Running: spinner + 动作描述 + 参数摘要
 *   - Done: ✓ + 工具名(参数摘要) — 输出作为 ⎿ 子块另起一行
 *   - Error: ✗ + 工具名(参数摘要) — 错误作为 ⎿ 子块另起一行
 */

import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { buildArgsSummary, formatDuration, truncate } from './format-utils.js'
import type { CompletedToolCall } from './ChatView.js'
import type { ToolResultMeta } from '@tools/core/types.js'

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

/** 工具执行事件，由 useChat 维护并传递给 ChatView */
export interface ToolEvent {
  id: string
  toolName: string
  /** 工具调用参数 */
  args?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  /** running 状态开始时间（Date.now()），用于 UI 计时显示 */
  startedAt?: number
  /** 仅 done/error 状态有值 */
  durationMs?: number
  /** 来自 tool_done 事件的结果/错误摘要 */
  resultSummary?: string
}

/** SubAgent 进度事件，由 useChat 从 subagent_progress 映射 */
export interface SubAgentEvent {
  id: string
  agentId: string
  name: string
  agentType: string
  description: string
  status: 'running' | 'done'
  turn: number
  maxTurns: number
  currentTool?: string
  durationMs?: number
}

// ═══════════════════════════════════════════════
// 工具名映射
// ═══════════════════════════════════════════════

/** 工具名 → 完成态显示名 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Update',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  dispatch_agent: 'Agent',
  ask_user_question: 'AskUser',
}

/** 工具名 → running 态动作描述 */
const TOOL_RUNNING_LABELS: Record<string, string> = {
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Editing',
  glob: 'Searching files',
  grep: 'Searching content',
  bash: 'Running',
  dispatch_agent: 'Dispatching agent',
  ask_user_question: '等待用户回答...',
}

function displayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName
}

function runningLabel(toolName: string): string {
  return TOOL_RUNNING_LABELS[toolName] ?? toolName
}

// ═══════════════════════════════════════════════
// 参数摘要提取
// ═══════════════════════════════════════════════

// buildArgsSummary 已迁移到 format-utils.ts（纯逻辑，不依赖 React），此处 re-export 保持兼容
export { buildArgsSummary } from './format-utils.js'

// ═══════════════════════════════════════════════
// 输出预览处理
// ═══════════════════════════════════════════════

/** 输出预览最大显示行数 */
const MAX_PREVIEW_LINES = 4

/**
 * 将 resultSummary 拆分为预览行 + 折叠提示。
 * 模仿 Claude Code 的 `⎿` 输出块样式：
 *   ⎿  第一行输出
 *      第二行输出
 *      ... +N lines (ctrl+o to expand)
 */
function buildOutputPreview(summary: string): { lines: string[]; foldHint: string } {
  if (!summary.trim()) return { lines: [], foldHint: '' }
  const allLines = summary.split('\n')
  const lines = allLines.slice(0, MAX_PREVIEW_LINES)
  const remaining = allLines.length - lines.length
  const foldHint = remaining > 0 ? `... +${remaining} lines (ctrl+o to expand)` : ''
  return { lines, foldHint }
}

// ═══════════════════════════════════════════════
// 渲染组件
// ═══════════════════════════════════════════════

/** Running 状态子组件 — 独立管理计时器 state，避免污染父组件 */
function ToolRunningLine({ toolName, argsSummary, startedAt }: { toolName: string; argsSummary: string; startedAt?: number }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!startedAt) return
    // 立即计算一次，避免首帧空白
    setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  const label = runningLabel(toolName)
  // 超过 3 秒才显示计时，避免短命令闪烁
  const timeStr = elapsed >= 3 ? `  ${elapsed}s` : ''

  return (
    <Box paddingLeft={1}>
      <Box marginRight={1}><Spinner type="dots" /></Box>
      <Text dimColor>
        {label}
        {argsSummary ? ` ${argsSummary}` : ''}
        ...
      </Text>
      {timeStr && <Text dimColor>{timeStr}</Text>}
    </Box>
  )
}

/** 渲染单条工具状态行（头部 + 可选的 ⎿ 输出子块） */
export function ToolStatusLine({ event }: { event: ToolEvent }) {
  const argsSummary = buildArgsSummary(event.toolName, event.args)

  // ---- Running 状态 ----
  if (event.status === 'running') {
    return <ToolRunningLine toolName={event.toolName} argsSummary={argsSummary} {...(event.startedAt != null ? { startedAt: event.startedAt } : {})} />
  }

  // ---- Done / Error 状态 ----
  const icon = event.status === 'done' ? '✓' : '✗'
  const color = event.status === 'done' ? 'green' : 'red'
  const name = displayName(event.toolName)
  const duration = event.durationMs != null ? formatDuration(event.durationMs) : ''

  // 输出预览：resultSummary 拆为 ⎿ 子块
  const { lines: previewLines, foldHint } = buildOutputPreview(event.resultSummary ?? '')

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* 头部行：icon + 工具名(参数摘要) + 耗时 */}
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={color} bold>{name}</Text>
        {argsSummary && <Text color={color}>({argsSummary})</Text>}
        {duration && <Text dimColor>  {duration}</Text>}
      </Box>

      {/* 输出子块：⎿ 连接符 + 缩进内容 */}
      {previewLines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {previewLines.map((line, i) => (
            <Box key={i}>
              <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
              <Text dimColor>{truncate(line, 120)}</Text>
            </Box>
          ))}
          {foldHint && (
            <Box>
              <Text dimColor>   {foldHint}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

/** 渲染 SubAgent 进度行 */
export function SubAgentStatusLine({ event }: { event: SubAgentEvent }) {
  if (event.status === 'running') {
    return (
      <Box paddingLeft={1}>
        <Box marginRight={1}><Spinner type="dots" /></Box>
        <Text dimColor>
          Agent[{event.name}]  turn {event.turn}/{event.maxTurns}
          {event.currentTool ? `  ▸ ${event.currentTool}` : ''}
        </Text>
      </Box>
    )
  }

  // done
  const duration = event.durationMs != null ? formatDuration(event.durationMs) : ''
  return (
    <Box paddingLeft={1}>
      <Text color="green">✓ </Text>
      <Text color="green" bold>Agent</Text>
      <Text color="green">[{event.name}]</Text>
      <Text dimColor>  completed</Text>
      {duration && <Text dimColor>  {duration}</Text>}
    </Box>
  )
}

// ═══════════════════════════════════════════════
// 历史工具调用渲染（Static 区）
// ═══════════════════════════════════════════════

/** diff 预览最大行数 */
const MAX_DIFF_LINES = 8
/** write 预览最大行数 */
const MAX_WRITE_PREVIEW_LINES = 4

/**
 * 根据 meta 生成头部摘要和输出块。
 * 无 meta 时退回到 resultSummary 做 ⎿ 预览（保持向后兼容）。
 */
function buildMetaDisplay(toolCall: CompletedToolCall): { headerSummary: string; outputBlock: React.ReactNode } {
  const meta = toolCall.meta as ToolResultMeta | undefined
  if (!meta) {
    // 无 meta：退回到 resultSummary 预览
    const { lines, foldHint } = buildOutputPreview(toolCall.resultSummary ?? '')
    return {
      headerSummary: '',
      outputBlock: lines.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {lines.map((line, i) => (
            <Box key={i}>
              <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
              <Text dimColor>{truncate(line, 120)}</Text>
            </Box>
          ))}
          {foldHint && <Box><Text dimColor>   {foldHint}</Text></Box>}
        </Box>
      ) : null,
    }
  }

  switch (meta.type) {
    case 'edit': {
      // 红绿 diff 行
      const diffLines = meta.diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
      const visible = diffLines.slice(0, MAX_DIFF_LINES)
      const remaining = diffLines.length - visible.length
      return {
        headerSummary: `+${meta.addedLines} -${meta.removedLines}`,
        outputBlock: visible.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {visible.map((line, i) => {
              const isAdd = line.startsWith('+')
              return (
                <Box key={i}>
                  <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
                  {isAdd
                    ? <Text color="green">{truncate(line, 120)}</Text>
                    : <Text dimColor>{truncate(line, 120)}</Text>
                  }
                </Box>
              )
            })}
            {remaining > 0 && (
              <Box><Text dimColor>   ... +{remaining} lines</Text></Box>
            )}
          </Box>
        ) : null,
      }
    }

    case 'write': {
      // 内容预览 + 行数
      const previewLines = meta.preview.split('\n').slice(0, MAX_WRITE_PREVIEW_LINES)
      const remaining = meta.totalLines - previewLines.length
      return {
        headerSummary: `${meta.totalLines} lines`,
        outputBlock: previewLines.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {previewLines.map((line, i) => (
              <Box key={i}>
                <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
                <Text dimColor>{truncate(line, 120)}</Text>
              </Box>
            ))}
            {remaining > 0 && (
              <Box><Text dimColor>   ... +{remaining} lines</Text></Box>
            )}
          </Box>
        ) : null,
      }
    }

    case 'read':
      // 仅行数摘要，无输出预览
      return { headerSummary: `${meta.totalLines} lines`, outputBlock: null }

    case 'grep': {
      // 匹配统计 + resultSummary 做 ⎿ 预览
      const { lines, foldHint } = buildOutputPreview(toolCall.resultSummary ?? '')
      return {
        headerSummary: `${meta.totalMatches} matches in ${meta.fileCount} files${meta.truncated ? ` (showing ${meta.displayedMatches})` : ''}`,
        outputBlock: lines.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {lines.map((line, i) => (
              <Box key={i}>
                <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
                <Text dimColor>{truncate(line, 120)}</Text>
              </Box>
            ))}
            {foldHint && <Box><Text dimColor>   {foldHint}</Text></Box>}
          </Box>
        ) : null,
      }
    }

    case 'glob': {
      // 文件数 + resultSummary 做 ⎿ 预览
      const { lines, foldHint } = buildOutputPreview(toolCall.resultSummary ?? '')
      return {
        headerSummary: `${meta.fileCount} files`,
        outputBlock: lines.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {lines.map((line, i) => (
              <Box key={i}>
                <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
                <Text dimColor>{truncate(line, 120)}</Text>
              </Box>
            ))}
            {foldHint && <Box><Text dimColor>   {foldHint}</Text></Box>}
          </Box>
        ) : null,
      }
    }

    case 'ask_user': {
      const summary = meta.answered
        ? `${meta.questionCount} 个问题已回答`
        : `${meta.questionCount} 个问题（已取消）`

      // 有 pairs 时渲染 question → answer 摘要
      const pairsBlock = meta.answered && meta.pairs && meta.pairs.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {meta.pairs.map((p, i) => (
            <Box key={i}>
              <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
              <Text dimColor>{'· '}</Text>
              <Text>{p.question}</Text>
              <Text dimColor>{' → '}</Text>
              <Text color="cyan">{p.answer}</Text>
            </Box>
          ))}
        </Box>
      ) : null

      return { headerSummary: summary, outputBlock: pairsBlock }
    }

    default:
      return { headerSummary: '', outputBlock: null }
  }
}

/**
 * ToolHistoryBlock — 已完成的工具调用在历史消息中的渲染。
 *
 * 支持两种模式：
 * 1. 有 meta 时：根据 meta.type 渲染丰富内容（diff 红绿行、write 预览、行数/匹配统计等）
 * 2. 无 meta 时：退回到 resultSummary 做 ⎿ 输出预览（向后兼容）
 */
export function ToolHistoryBlock({ toolCall }: { toolCall: CompletedToolCall }) {
  const name = displayName(toolCall.toolName)
  const argsSummary = buildArgsSummary(toolCall.toolName, toolCall.args)
  const color = toolCall.success ? 'green' : 'red'
  const icon = toolCall.success ? '✓' : '✗'
  const duration = formatDuration(toolCall.durationMs)

  // 根据 meta 生成头部摘要和输出内容
  const { headerSummary, outputBlock } = buildMetaDisplay(toolCall)

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* 头部行：icon + 工具名(参数摘要) + meta 摘要 + 耗时 */}
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={color} bold>{name}</Text>
        {argsSummary && <Text color={color}>({argsSummary})</Text>}
        {headerSummary && <Text dimColor>  {headerSummary}</Text>}
        <Text dimColor>  {duration}</Text>
      </Box>

      {/* 输出子块 */}
      {outputBlock}
    </Box>
  )
}

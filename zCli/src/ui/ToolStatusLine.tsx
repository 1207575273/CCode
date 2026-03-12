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

import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { formatDuration, truncate } from './format-utils.js'
import type { CompletedToolCall } from './ChatView.js'

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
  /** 仅 done/error 状态有值 */
  durationMs?: number
  /** 来自 tool_done 事件的结果/错误摘要 */
  resultSummary?: string
}

/** SubAgent 进度事件，由 useChat 从 subagent_progress 映射 */
export interface SubAgentEvent {
  id: string
  agentId: string
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

/** 最大参数摘要长度 */
const MAX_ARGS_LENGTH = 80

/**
 * 从工具参数中提取人类可读的摘要。
 * 纯 UI 层函数，不依赖工具实现。
 */
export function buildArgsSummary(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return ''

  switch (toolName) {
    case 'bash':
      return truncate(String(args['command'] ?? ''), MAX_ARGS_LENGTH)

    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return truncate(String(args['path'] ?? ''), MAX_ARGS_LENGTH)

    case 'grep': {
      const pattern = args['pattern'] ?? ''
      const path = args['path'] ?? '.'
      return truncate(`pattern: "${pattern}", path: ${path}`, MAX_ARGS_LENGTH)
    }

    case 'glob':
      return truncate(String(args['pattern'] ?? ''), MAX_ARGS_LENGTH)

    case 'dispatch_agent':
      return truncate(String(args['description'] ?? ''), MAX_ARGS_LENGTH)

    default: {
      // MCP 等未知工具：提取第一个字符串参数作为摘要
      const firstStringArg = Object.values(args).find(v => typeof v === 'string')
      if (typeof firstStringArg === 'string') {
        return truncate(firstStringArg, MAX_ARGS_LENGTH)
      }
      return ''
    }
  }
}

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

/** 渲染单条工具状态行（头部 + 可选的 ⎿ 输出子块） */
export function ToolStatusLine({ event }: { event: ToolEvent }) {
  const argsSummary = buildArgsSummary(event.toolName, event.args)

  // ---- Running 状态 ----
  if (event.status === 'running') {
    const label = runningLabel(event.toolName)
    return (
      <Box paddingLeft={1}>
        <Box marginRight={1}><Spinner type="dots" /></Box>
        <Text dimColor>
          {label}
          {argsSummary ? ` ${argsSummary}` : ''}
          ...
        </Text>
      </Box>
    )
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
          Agent[{event.description}]  turn {event.turn}/{event.maxTurns}
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
      <Text color="green">[{event.description}]</Text>
      <Text dimColor>  completed</Text>
      {duration && <Text dimColor>  {duration}</Text>}
    </Box>
  )
}

// ═══════════════════════════════════════════════
// 历史工具调用渲染（Static 区）
// ═══════════════════════════════════════════════

/**
 * ToolHistoryBlock — 已完成的工具调用在历史消息中的渲染。
 *
 * 对标 Claude Code 的历史态工具显示：
 *   Bash(cd "/tmp" && mvn compile -q 2>&1 | tail -5)
 *   ⎿  [INFO] BUILD SUCCESS
 *      ... +15 lines (ctrl+o to expand)
 */
export function ToolHistoryBlock({ toolCall }: { toolCall: CompletedToolCall }) {
  const name = displayName(toolCall.toolName)
  const argsSummary = buildArgsSummary(toolCall.toolName, toolCall.args)
  const color = toolCall.success ? 'green' : 'red'
  const icon = toolCall.success ? '✓' : '✗'
  const duration = formatDuration(toolCall.durationMs)

  const { lines: previewLines, foldHint } = buildOutputPreview(toolCall.resultSummary ?? '')

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* 头部行 */}
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={color} bold>{name}</Text>
        {argsSummary && <Text color={color}>({argsSummary})</Text>}
        <Text dimColor>  {duration}</Text>
      </Box>

      {/* ⎿ 输出子块 */}
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

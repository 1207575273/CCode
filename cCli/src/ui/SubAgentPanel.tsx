// src/ui/SubAgentPanel.tsx

/**
 * SubAgentPanel — 子 Agent 悬浮面板。
 *
 * 两个视图：
 * 1. 列表视图：显示所有子 Agent 摘要，↑↓ 选择，Enter 进入详情
 * 2. 详情视图：显示选中子 Agent 的工具调用历史，ESC/Ctrl+B/Q 返回
 *
 * 数据来源：subagent-store 内存缓存（实时）
 */

import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'
import { listSubAgents, getSubAgent } from '@tools/ext/subagent-store.js'
import type { SubAgentState, SubAgentDetailEvent } from '@tools/ext/subagent-store.js'
import { formatDuration } from './format-utils.js'

interface SubAgentPanelProps {
  /** 关闭面板回调 */
  onClose: () => void
}

/** 截断字符串 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** 详情视图：渲染单个子 Agent 的事件列表 */
function DetailView({ state, onBack }: { state: SubAgentState; onBack: () => void }) {
  const [scrollOffset, setScrollOffset] = useState(0)
  const maxVisible = 12

  useInput((_input, key) => {
    if (key.escape || _input === 'q' || (key.ctrl && _input === 'b')) {
      onBack()
    }
    if (key.upArrow) {
      setScrollOffset(prev => Math.max(0, prev - 1))
    }
    if (key.downArrow) {
      setScrollOffset(prev => Math.min(Math.max(0, state.events.length - maxVisible), prev + 1))
    }
  })

  const elapsed = state.finishedAt
    ? formatDuration(state.finishedAt - state.startedAt)
    : formatDuration(Date.now() - state.startedAt)

  const visibleEvents = state.events.slice(scrollOffset, scrollOffset + maxVisible)
  const hasMore = state.events.length > scrollOffset + maxVisible

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* 标题栏 */}
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>Agent: </Text>
          <Text>{truncate(state.description, 40)}</Text>
          <Text dimColor> {elapsed}</Text>
        </Text>
        <Text dimColor>ESC 返回</Text>
      </Box>

      {/* 状态行 */}
      <Box>
        {state.status === 'running' ? (
          <>
            <Box marginRight={1}><Spinner type="dots" /></Box>
            <Text dimColor>
              turn {state.turn}/{state.maxTurns}
              {state.currentTool ? `  ▸ ${state.currentTool}` : ''}
            </Text>
          </>
        ) : (
          <Text color={state.status === 'done' ? 'green' : 'red'}>
            {state.status === 'done' ? '✓ 完成' : '✗ 异常'}
          </Text>
        )}
      </Box>

      {/* 事件列表 */}
      <Box flexDirection="column" marginTop={1}>
        {state.events.length === 0 ? (
          <Text dimColor>(等待事件...)</Text>
        ) : (
          <>
            {scrollOffset > 0 && <Text dimColor>  ↑ {scrollOffset} more</Text>}
            {visibleEvents.map((evt, i) => (
              <EventLine key={scrollOffset + i} event={evt} />
            ))}
            {hasMore && <Text dimColor>  ↓ {state.events.length - scrollOffset - maxVisible} more</Text>}
          </>
        )}
      </Box>
    </Box>
  )
}

/** 渲染单条事件 */
function EventLine({ event }: { event: SubAgentDetailEvent }) {
  switch (event.type) {
    case 'tool_start':
      return (
        <Box paddingLeft={1}>
          <Box marginRight={1}><Spinner type="dots" /></Box>
          <Text dimColor>{event.toolName}({truncate(summarizeArgs(event.args), 50)})...</Text>
        </Box>
      )
    case 'tool_done':
      return (
        <Box paddingLeft={1}>
          <Text color={event.success ? 'green' : 'red'}>
            {event.success ? '✓' : '✗'}{' '}
          </Text>
          <Text color={event.success ? 'green' : 'red'}>
            {event.toolName}
          </Text>
          {event.durationMs != null && <Text dimColor>  {formatDuration(event.durationMs)}</Text>}
          {event.resultSummary && (
            <Text dimColor>  ⎿ {truncate(event.resultSummary.split('\n')[0] ?? '', 60)}</Text>
          )}
        </Box>
      )
    case 'text':
      return (
        <Box paddingLeft={1}>
          <Text dimColor>📝 {truncate(event.text ?? '', 80)}</Text>
        </Box>
      )
    case 'error':
      return (
        <Box paddingLeft={1}>
          <Text color="red">✗ {truncate(event.error ?? '', 80)}</Text>
        </Box>
      )
    default:
      return null
  }
}

/** 提取参数摘要 */
function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return ''
  const first = Object.values(args).find(v => typeof v === 'string')
  return typeof first === 'string' ? first : ''
}

/** 列表视图 */
function ListView({ agents, selectedIndex, onSelect, onClose }: {
  agents: SubAgentState[]
  selectedIndex: number
  onSelect: (agentId: string) => void
  onClose: () => void
}) {
  useInput((_input, key) => {
    if (key.escape || _input === 'q' || (key.ctrl && _input === 'b')) {
      onClose()
    }
    if (key.return) {
      const agent = agents[selectedIndex]
      if (agent) onSelect(agent.agentId)
    }
  })

  const running = agents.filter(a => a.status === 'running').length

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* 标题栏 */}
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>SubAgents</Text>
          <Text dimColor> ({agents.length})</Text>
          {running > 0 && <Text color="yellow"> {running} running</Text>}
        </Text>
        <Text dimColor>Ctrl+B 关闭</Text>
      </Box>

      {/* Agent 列表 */}
      {agents.map((agent, i) => {
        const isSelected = i === selectedIndex
        const elapsed = agent.finishedAt
          ? formatDuration(agent.finishedAt - agent.startedAt)
          : formatDuration(Date.now() - agent.startedAt)

        return (
          <Box key={agent.agentId} paddingLeft={1}>
            <Text {...(isSelected ? { color: 'cyan' as const } : {})}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            {agent.status === 'running' ? (
              <>
                <Box marginRight={1}><Spinner type="dots" /></Box>
                <Text>{truncate(agent.description, 30)}</Text>
                <Text dimColor>  turn {agent.turn}/{agent.maxTurns}</Text>
                {agent.currentTool && <Text dimColor>  ▸ {agent.currentTool}</Text>}
              </>
            ) : (
              <>
                <Text color={agent.status === 'done' ? 'green' : 'red'}>
                  {agent.status === 'done' ? '✓' : '✗'}{' '}
                </Text>
                <Text>{truncate(agent.description, 30)}</Text>
                <Text dimColor>  {elapsed}</Text>
              </>
            )}
          </Box>
        )
      })}

      {/* 操作提示 */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择  Enter 查看详情  Ctrl+B/ESC 关闭</Text>
      </Box>
    </Box>
  )
}

/** SubAgentPanel 主组件 */
export function SubAgentPanel({ onClose }: SubAgentPanelProps) {
  const agents = listSubAgents()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null)

  // 列表视图按键：↑↓ 导航
  useInput((_input, key) => {
    if (detailAgentId != null) return // 详情视图有自己的按键处理
    if (key.upArrow) {
      setSelectedIndex(prev => prev <= 0 ? agents.length - 1 : prev - 1)
    }
    if (key.downArrow) {
      setSelectedIndex(prev => prev >= agents.length - 1 ? 0 : prev + 1)
    }
  }, { isActive: detailAgentId == null })

  const handleSelect = useCallback((agentId: string) => {
    setDetailAgentId(agentId)
  }, [])

  const handleBack = useCallback(() => {
    setDetailAgentId(null)
  }, [])

  // 详情视图
  if (detailAgentId != null) {
    const state = getSubAgent(detailAgentId)
    if (!state) {
      setDetailAgentId(null)
      return null
    }
    return <DetailView state={state} onBack={handleBack} />
  }

  // 无子 Agent 时不显示
  if (agents.length === 0) {
    return null
  }

  // 列表视图
  return (
    <ListView
      agents={agents}
      selectedIndex={Math.min(selectedIndex, agents.length - 1)}
      onSelect={handleSelect}
      onClose={onClose}
    />
  )
}

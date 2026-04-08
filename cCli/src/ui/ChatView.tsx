// src/ui/ChatView.tsx

/**
 * ChatView — 消息列表渲染组件。
 *
 * 性能优化：使用 Ink 的 <Static> 将已完成的消息"固化"到终端输出，
 * 不再参与后续 re-render 和 diff 计算。只有流式气泡和工具事件参与动态渲染。
 * 这将长对话的渲染成本从 O(n) 降为 O(1)，消除长对话时的闪烁/卡顿。
 *
 * system 消息来自指令系统（/help 输出、切换确认等），以灰色左竖线样式呈现，
 * 不发送给 LLM（useChat.submit() 在构建 history 时会过滤掉它们）。
 */

import React from 'react'
import { Box, Static, Text } from 'ink'
import Spinner from 'ink-spinner'
import { ToolStatusLine, ToolHistoryBlock, SubAgentStatusLine, type ToolEvent, type SubAgentEvent } from './ToolStatusLine.js'
import type { ToolResultMeta } from '@tools/core/types.js'

/** 已完成的工具调用记录，持久化到 messages 历史中 */
export interface CompletedToolCall {
  toolName: string
  args: Record<string, unknown>
  durationMs: number
  success: boolean
  resultSummary?: string
  resultFull?: string
  /** 结构化元数据，用于渲染丰富的工具结果展示（diff、文件预览等） */
  meta?: ToolResultMeta
}

/** 单条聊天消息的数据结构，与 LLM Message 类型分离（system/tool 仅用于 UI）。 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** 仅 role=tool 时有值：已完成的工具调用详情 */
  toolCall?: CompletedToolCall
  /** assistant 消息的模型名 */
  model?: string
  /** assistant 消息的供应商名 */
  provider?: string
  /** 思考过程（extended thinking） */
  thinking?: string
  /** 本轮 token 用量 */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  /** 本轮 LLM 调用次数 */
  llmCallCount?: number
  /** 本轮工具调用次数 */
  toolCallCount?: number
}

/** 截断字符串，超出部分加省略号 */
function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

/** user/assistant 角色的颜色和标签配置，system 走独立渲染分支。 */
const ROLE_CONFIG = {
  user: { color: 'green' as const, label: '> 你' },
  assistant: { color: 'cyan' as const, label: '◆ CCode' },
} as const

interface ChatViewProps {
  messages: ChatMessage[]
  /** null/undefined = 空闲；'' = 等待首 token；非空字符串 = 流式内容累积中 */
  streamingMessage?: string | null
  toolEvents?: ToolEvent[]
  /** SubAgent 进度事件 */
  subAgentEvents?: SubAgentEvent[]
}

/** 渲染单条消息（提取为独立组件，供 Static 和动态区域复用） */
function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'system') {
    return (
      <Box paddingLeft={1} borderStyle="single" borderLeft={true} borderColor="gray" borderRight={false} borderTop={false} borderBottom={false}>
        <Text dimColor>{msg.content}</Text>
      </Box>
    )
  }
  if (msg.role === 'tool' && msg.toolCall) {
    return <ToolHistoryBlock toolCall={msg.toolCall} />
  }
  const roleKey = msg.role as 'user' | 'assistant'
  return (
    <>
      <Box>
        <Text color={ROLE_CONFIG[roleKey].color} bold>
          {ROLE_CONFIG[roleKey].label}
        </Text>
        {msg.role === 'assistant' && (msg.provider || msg.model) && (
          <Text dimColor> ({msg.provider ?? ''}{msg.provider && msg.model ? '/' : ''}{msg.model ?? ''})</Text>
        )}
      </Box>
      {msg.role === 'assistant' && msg.thinking && (
        <Box paddingLeft={2} borderStyle="single" borderLeft={true} borderColor="yellow" borderRight={false} borderTop={false} borderBottom={false}>
          <Text dimColor>💭 {truncate(msg.thinking, 200)}</Text>
        </Box>
      )}
      <Text>{msg.content}</Text>
    </>
  )
}

/**
 * 渲染对话区域。
 *
 * <Static> 包裹已完成的消息 — 写入终端后不再参与 diff/重绘。
 * 动态区域只包含工具事件和流式气泡，渲染成本恒定。
 */
export function ChatView({ messages, streamingMessage, toolEvents, subAgentEvents }: ChatViewProps) {
  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      {/* 已完成的消息：固化到终端，不参与重渲染 */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id} marginBottom={1} flexDirection="column">
            <MessageBubble msg={msg} />
          </Box>
        )}
      </Static>

      {/* 工具执行状态：仅显示正在运行的工具（已完成的通过 messages 固化到 Static） */}
      {(toolEvents ?? []).filter(e => e.status === 'running').map(e => (
        <ToolStatusLine key={e.id} event={e} />
      ))}

      {/* SubAgent 进度：实时显示子 Agent 执行状态 */}
      {(subAgentEvents ?? []).filter(e => e.status === 'running').map(e => (
        <SubAgentStatusLine key={e.id} event={e} />
      ))}

      {/* 流式气泡：streamingMessage 不为 null/undefined 时显示 */}
      {streamingMessage != null && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan" bold>◆ CCode</Text>
          {streamingMessage === '' || streamingMessage === '⏳ 思考中...' ? (
            <Box>
              <Spinner type="dots" />
              <Text dimColor> 思考中...</Text>
            </Box>
          ) : (
            <Text>{streamingMessage}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

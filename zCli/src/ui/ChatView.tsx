// src/ui/ChatView.tsx
import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { ToolStatusLine, type ToolEvent } from './ToolStatusLine.js'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const ROLE_CONFIG = {
  user: { color: 'green' as const, label: '> 你' },
  assistant: { color: 'cyan' as const, label: '◆ ZCli' },
} as const

interface ChatViewProps {
  messages: ChatMessage[]
  streamingMessage?: string | null  // null/undefined = 空闲; '' = 等待首 token; string = 流入中
  toolEvents?: ToolEvent[]
}

export function ChatView({ messages, streamingMessage, toolEvents }: ChatViewProps) {
  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      {messages.map((msg) => (
        <Box key={msg.id} marginBottom={1} flexDirection="column">
          <Text color={ROLE_CONFIG[msg.role].color} bold>
            {ROLE_CONFIG[msg.role].label}
          </Text>
          <Text>{msg.content}</Text>
        </Box>
      ))}

      {(toolEvents ?? []).map(e => (
        <ToolStatusLine key={e.id} event={e} />
      ))}

      {/* 流式气泡：streamingMessage 不为 null/undefined 时显示 */}
      {streamingMessage != null && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan" bold>◆ ZCli</Text>
          {streamingMessage === '' ? (
            <Box>
              <Spinner type="dots" />
            </Box>
          ) : (
            <Text>{streamingMessage}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

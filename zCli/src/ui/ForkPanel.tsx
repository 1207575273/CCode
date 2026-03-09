// src/ui/ForkPanel.tsx

/**
 * ForkPanel — 显示当前对话消息列表，用户选择分叉点。
 * 选择后从该消息处分叉，开始新分支。
 */

import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key } from 'ink'
import type { ChatMessage } from './ChatView.js'

export interface ForkPanelProps {
  messages: ChatMessage[]
  onFork: (messageId: string) => void
  onClose: () => void
}

const MAX_PREVIEW_LENGTH = 70

export function ForkPanel({ messages, onFork, onClose }: ForkPanelProps) {
  // 只展示 user 和 assistant 消息（排除 system）
  const forkableMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const [selectedIndex, setSelectedIndex] = useState(forkableMessages.length - 1)

  const handler = useCallback((input: string, key: Key) => {
    if (key.escape) {
      onClose()
      return
    }

    if (key.return) {
      const msg = forkableMessages[selectedIndex]
      if (msg) {
        onFork(msg.id)
      }
      return
    }

    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(i => Math.min(forkableMessages.length - 1, i + 1))
      return
    }
  }, [onClose, onFork, forkableMessages, selectedIndex])

  useInput(handler)

  if (forkableMessages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Fork Conversation</Text>
        <Text dimColor>No messages to fork from. Start a conversation first.</Text>
        <Text> </Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Fork Conversation</Text>
      <Text dimColor>  Select a message to fork from — conversation will branch from this point</Text>
      <Text> </Text>

      {forkableMessages.map((msg, index) => {
        const isSelected = index === selectedIndex
        const prefix = isSelected ? '> ' : '  '
        const roleTag = msg.role === 'user' ? '[You]' : '[AI]'
        const preview = msg.content.length > MAX_PREVIEW_LENGTH
          ? msg.content.slice(0, MAX_PREVIEW_LENGTH) + '...'
          : msg.content
        // 将换行替换为空格，保持单行预览
        const cleanPreview = preview.replace(/\n/g, ' ')

        return (
          <Box key={msg.id}>
            {isSelected ? (
              <Text color="cyan" bold>{prefix}{roleTag} {cleanPreview}</Text>
            ) : (
              <Text>{prefix}<Text dimColor>{roleTag}</Text> {cleanPreview}</Text>
            )}
          </Box>
        )
      })}

      <Text> </Text>
      <Box>
        <Text dimColor>Up/Down navigate - Enter fork from here - Esc cancel</Text>
      </Box>
    </Box>
  )
}

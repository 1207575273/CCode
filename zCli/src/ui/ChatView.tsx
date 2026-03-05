// src/ui/ChatView.tsx
import React, { useState } from 'react'
import { Box, Text, useApp } from 'ink'
import TextInput from 'ink-text-input'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export function ChatView() {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])

  function handleSubmit(value: string) {
    const text = value.trim()
    if (!text) return
    if (text === '/exit' || text === '/quit') {
      exit()
      return
    }
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setInput('')
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 消息区 */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {messages.length === 0 ? (
          <Text dimColor>输入消息开始对话，输入 /exit 退出</Text>
        ) : (
          messages.map((msg, i) => (
            <Box key={i} marginBottom={1} flexDirection="column">
              <Text color={msg.role === 'user' ? 'green' : 'cyan'} bold>
                {msg.role === 'user' ? '> 你' : '◆ ZCli'}
              </Text>
              <Text>{msg.content}</Text>
            </Box>
          ))
        )}
      </Box>

      {/* 输入区 */}
      <Box borderStyle="single" paddingX={1} marginX={1}>
        <Text color="green">❯ </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="输入消息..."
        />
      </Box>
    </Box>
  )
}

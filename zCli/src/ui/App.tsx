// src/ui/App.tsx
import React from 'react'
import { Box, Text } from 'ink'
import { StatusBar } from './StatusBar.js'
import { ChatView } from './ChatView.js'

interface AppProps {
  model?: string
  provider?: string
  sessionId?: string
}

export function App({
  model = 'claude-opus-4-6',
  provider = 'anthropic',
  sessionId = 'sess_00000000_000000_000',
}: AppProps) {
  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1} marginBottom={1}>
        <Text bold color="blue">ZCli</Text>
        <Text dimColor> — 多模型 AI 编程助手 v0.1.0</Text>
      </Box>

      <ChatView />

      <Box marginTop={1}>
        <StatusBar model={model} provider={provider} sessionId={sessionId} />
      </Box>
    </Box>
  )
}

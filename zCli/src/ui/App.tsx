// src/ui/App.tsx
import React from 'react'
import { Box, Text, useApp } from 'ink'
import { WelcomeScreen } from './WelcomeScreen.js'
import { ChatView } from './ChatView.js'
import { InputBar } from './InputBar.js'
import { PermissionDialog } from './PermissionDialog.js'
import { useChat } from './useChat.js'
import { configManager } from '@config/config-manager.js'

interface AppProps {
  model?: string
  provider?: string
  cwd?: string
}

export function App({
  model,
  provider,
  cwd = process.cwd(),
}: AppProps) {
  const { exit } = useApp()
  const { messages, streamingMessage, toolEvents, isStreaming, error, submit, abort: _abort, pendingPermission, resolvePermission } = useChat()

  // 从 config 读取当前模型/provider（props 可覆盖）
  const config = configManager.load()
  const currentModel = model ?? config.defaultModel
  const currentProvider = provider ?? config.defaultProvider

  const started = messages.length > 0 || isStreaming

  function handleSubmit(text: string) {
    if (text === '/exit' || text === '/quit') {
      exit()
      return
    }
    submit(text)
  }

  return (
    <Box flexDirection="column" width="100%">
      {started ? (
        <ChatView messages={messages} streamingMessage={streamingMessage} toolEvents={toolEvents} />
      ) : (
        <WelcomeScreen model={currentModel} provider={currentProvider} cwd={cwd} />
      )}

      {error != null && (
        <Box paddingX={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      {pendingPermission != null ? (
        <PermissionDialog
          toolName={pendingPermission.toolName}
          args={pendingPermission.args}
          onResolve={resolvePermission}
        />
      ) : (
        <InputBar
          onSubmit={handleSubmit}
          disabled={isStreaming}
        />
      )}
    </Box>
  )
}

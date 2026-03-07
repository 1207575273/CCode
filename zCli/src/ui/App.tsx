// src/ui/App.tsx
import React, { useState, useCallback, useMemo } from 'react'
import { Box, Text, useApp } from 'ink'
import { WelcomeScreen } from './WelcomeScreen.js'
import { ChatView } from './ChatView.js'
import { InputBar } from './InputBar.js'
import { PermissionDialog } from './PermissionDialog.js'
import { ModelPicker } from './ModelPicker.js'
import type { ModelItem } from './ModelPicker.js'
import { useChat } from './useChat.js'
import { configManager } from '@config/config-manager.js'
import { CommandRegistry } from '@commands/registry.js'
import { ClearCommand } from '@commands/clear.js'
import { HelpCommand } from '@commands/help.js'
import { ModelCommand } from '@commands/model.js'

interface AppProps {
  model?: string
  provider?: string
  cwd?: string
}

export function App({
  model: _model,
  provider: _provider,
  cwd = process.cwd(),
}: AppProps) {
  const { exit } = useApp()
  const {
    messages,
    streamingMessage,
    toolEvents,
    isStreaming,
    error,
    submit,
    abort: _abort,
    pendingPermission,
    resolvePermission,
    currentProvider,
    currentModel,
    clearMessages,
    appendSystemMessage,
    switchModel,
  } = useChat()

  const [showModelPicker, setShowModelPicker] = useState(false)

  const started = messages.length > 0 || isStreaming

  // CommandRegistry — 当 provider/model 变化时重建，确保 /model 指令能感知当前状态
  const registry = useMemo(() => {
    const reg = new CommandRegistry()
    reg.register(new ClearCommand())
    reg.register(new HelpCommand(() => reg.getAll()))
    reg.register(new ModelCommand(currentProvider, currentModel))
    return reg
  }, [currentProvider, currentModel])

  // ModelPicker items — 从 config 中枚举所有 provider 的所有 model
  const modelItems: ModelItem[] = useMemo(() => {
    const config = configManager.load()
    const items: ModelItem[] = []
    for (const [providerKey, providerConfig] of Object.entries(config.providers)) {
      if (!providerConfig) continue
      for (const m of providerConfig.models) {
        items.push({ provider: providerKey, model: m })
      }
    }
    return items
  }, [])

  const handleSubmit = useCallback((input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return

    // /exit 和 /quit 不通过 CommandRegistry，直接退出应用
    if (trimmed === '/exit' || trimmed === '/quit') {
      exit()
      return
    }

    // 斜杠指令分发
    const result = registry.dispatch(trimmed)
    if (result.handled) {
      const action = result.action
      if (action) {
        switch (action.type) {
          case 'clear_messages':
            clearMessages()
            return
          case 'show_help':
            appendSystemMessage(action.content)
            return
          case 'show_model_picker':
            setShowModelPicker(true)
            return
          case 'switch_model': {
            let targetProvider = action.provider
            let targetModel = action.model
            // 如果 provider 为空，从 modelItems 里匹配 model 名找对应 provider
            if (!targetProvider) {
              const found = modelItems.find(item => item.model === action.model)
              if (found) {
                targetProvider = found.provider
                targetModel = found.model
              }
            }
            if (targetProvider) {
              switchModel(targetProvider, targetModel)
              appendSystemMessage(`已切换到 ${targetModel} (${targetProvider})`)
            } else {
              appendSystemMessage(`未找到模型: ${action.model}`)
            }
            return
          }
          case 'error':
            appendSystemMessage(action.message)
            return
        }
      }
      return
    }

    // 非指令，发送给 LLM
    submit(trimmed)
  }, [registry, clearMessages, appendSystemMessage, switchModel, submit, modelItems, exit])

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
      ) : showModelPicker ? (
        <ModelPicker
          currentProvider={currentProvider}
          currentModel={currentModel}
          items={modelItems}
          onSelect={(provider, model) => {
            switchModel(provider, model)
            appendSystemMessage(`已切换到 ${model} (${provider})`)
            setShowModelPicker(false)
          }}
          onCancel={() => setShowModelPicker(false)}
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

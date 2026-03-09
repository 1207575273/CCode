// src/ui/App.tsx
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { WelcomeScreen } from './WelcomeScreen.js'
import { ChatView } from './ChatView.js'
import { InputBar } from './InputBar.js'
import { PermissionDialog } from './PermissionDialog.js'
import { ModelPicker } from './ModelPicker.js'
import type { ModelItem } from './ModelPicker.js'
import { CommandSuggestion } from './CommandSuggestion.js'
import type { SuggestionItem } from './CommandSuggestion.js'
import { useChat } from './useChat.js'
import { configManager } from '@config/config-manager.js'
import { CommandRegistry } from '@commands/registry.js'
import { ClearCommand } from '@commands/clear.js'
import { HelpCommand } from '@commands/help.js'
import { ModelCommand } from '@commands/model.js'
import { McpCommand } from '@commands/mcp.js'
import { ResumeCommand } from '@commands/resume.js'
import { McpStatusView } from './McpStatusView.js'
import { ResumePanel } from './ResumePanel.js'
import type { ServerInfo } from '@mcp/mcp-manager.js'
import { sessionStore, toProjectSlug } from '@persistence/index.js'

/**
 * App — ZCli 根组件
 *
 * 职责：
 * - 组合所有 UI 模块（WelcomeScreen / ChatView / InputBar / CommandSuggestion / PermissionDialog / ModelPicker）
 * - 维护顶层 UI 状态：inputValue、suggestionIndex、showModelPicker
 * - 处理斜杠指令分发（CommandRegistry → Action → useChat 方法）
 * - 管理指令建议浮层：过滤建议、键盘导航、Tab/Enter 补全到输入框
 */

interface AppProps {
  model?: string
  provider?: string
  cwd?: string
  resumeSessionId?: string | undefined
  showResumeOnStart?: boolean | undefined
}

export function App({
  model: _model,
  provider: _provider,
  cwd = process.cwd(),
  resumeSessionId,
  showResumeOnStart,
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
    getMcpInfo,
    loadSession,
  } = useChat()

  const [showModelPicker, setShowModelPicker] = useState(false)
  /** /mcp 指令触发后填充，展示 MCP Server 状态 */
  const [mcpServers, setMcpServers] = useState<ServerInfo[] | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  // Tab 补全后递增，使 InputBar key 变化以强制重挂载，确保 cursor 归位到末尾
  const [inputResetKey, setInputResetKey] = useState(0)
  // useRef: read latest value in async callbacks without closure staleness
  // (same dual-track pattern as allowedToolsRef in useChat)
  const suggestionConsumedRef = useRef(false)
  // suggestionIndexRef: useInput 回调内读取最新索引值（避免闭包捕获陈旧 state）
  const suggestionIndexRef = useRef(0)
  /** /mcp 面板是否正在加载中 */
  const [mcpLoading, setMcpLoading] = useState(false)
  /** /resume 面板是否显示 */
  const [showResumePanel, setShowResumePanel] = useState(false)

  // 懒加载 session 列表：仅在 ResumePanel 打开时读取
  const { currentProjectSessions, allSessions } = useMemo(() => {
    if (!showResumePanel) return { currentProjectSessions: [], allSessions: [] }
    const slug = toProjectSlug(cwd)
    return {
      currentProjectSessions: sessionStore.list({ projectSlug: slug, limit: 10 }),
      allSessions: sessionStore.list({ limit: 10 }),
    }
  }, [showResumePanel, cwd])

  // WelcomeScreen 用的最近会话（最多 3 条）
  const recentSessions = useMemo(() => {
    try {
      const slug = toProjectSlug(cwd)
      return sessionStore.list({ projectSlug: slug, limit: 3 }).map(s => ({
        firstMessage: s.firstMessage,
        updatedAt: s.updatedAt,
      }))
    } catch {
      return []
    }
  }, [cwd])

  const started = messages.length > 0 || isStreaming

  // Handle --resume CLI flag
  useEffect(() => {
    if (resumeSessionId) {
      // Direct resume by sessionId
      loadSession(resumeSessionId)
    } else if (showResumeOnStart) {
      // Show resume panel
      setShowResumePanel(true)
    }
  }, []) // Only on mount

  // CommandRegistry — 当 provider/model 变化时重建，确保 /model 指令能感知当前状态
  const registry = useMemo(() => {
    const reg = new CommandRegistry()
    reg.register(new ClearCommand())
    reg.register(new HelpCommand(() => reg.getAll()))
    reg.register(new ModelCommand(currentProvider, currentModel))
    reg.register(new McpCommand())
    reg.register(new ResumeCommand())
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

  // suggestions: 当输入以 "/" 开头时实时过滤可用指令，驱动建议浮层显示
  const suggestions: SuggestionItem[] = useMemo(() => {
    if (!inputValue.startsWith('/')) return []
    const query = inputValue.slice(1).toLowerCase()
    return registry.getAll().filter(cmd =>
      cmd.name.startsWith(query) ||
      cmd.aliases?.some(a => a.startsWith(query))
    )
  }, [inputValue, registry])

  // inputValue 变化时重置高亮索引，避免越界
  useEffect(() => {
    setSuggestionIndex(0)
    suggestionIndexRef.current = 0  // 同步 ref，供 useInput 闭包读取
  }, [inputValue])

  const handleSubmit = useCallback((input: string) => {
    // 建议浮层已通过 useInput 处理了 Enter：
    // 此时 inputValue 已被 useInput 设为补全后的值（如 '/model '），
    // 不能在这里清空——否则会覆盖补全结果。直接返回即可。
    if (suggestionConsumedRef.current) {
      suggestionConsumedRef.current = false
      return
    }
    setInputValue('')
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
          case 'show_resume_panel':
            setShowResumePanel(true)
            return
          case 'show_mcp_status':
            setMcpLoading(true)
            setMcpServers(null)
            void (async () => {
              try {
                const servers = await getMcpInfo()
                setMcpServers(servers)
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err)
                appendSystemMessage(`MCP 状态获取失败: ${message}`)
              } finally {
                setMcpLoading(false)
              }
            })()
            return
          case 'error':
            appendSystemMessage(action.message)
            return
        }
      }
      return
    }

    // 非指令，发送给 LLM
    submit(trimmed)
  }, [registry, clearMessages, appendSystemMessage, switchModel, submit, modelItems, exit, getMcpInfo])

  // isActive: 仅在浮层可见时拦截按键，防止与 TextInput 的正常 Enter 冲突
  useInput((_input, key) => {
    if (key.upArrow) {
      setSuggestionIndex(i => {
        const next = Math.max(0, i - 1)
        suggestionIndexRef.current = next  // 同步 ref
        return next
      })
    }
    if (key.downArrow) {
      setSuggestionIndex(i => {
        const next = Math.min(suggestions.length - 1, i + 1)
        suggestionIndexRef.current = next  // 同步 ref
        return next
      })
    }
    // Tab: 仅补全，不设 ref（Tab 不触发 onSubmit，无需防重触发）
    // setInputResetKey 强制 InputBar 重挂载，使 ink-text-input 的 cursor 归位到末尾
    if (key.tab) {
      const cmd = suggestions[suggestionIndexRef.current]
      if (cmd) {
        setInputValue('/' + cmd.name + ' ')
        setInputResetKey(k => k + 1)
      }
    }
    // Enter: 补全并设 ref，阻断 TextInput.onSubmit 的同 tick 重复触发
    if (key.return) {
      const cmd = suggestions[suggestionIndexRef.current]
      if (cmd) {
        suggestionConsumedRef.current = true
        setInputValue('/' + cmd.name + ' ')
        setInputResetKey(k => k + 1)  // 强制 InputBar 重挂载，cursor 归位到末尾
      }
    }
    if (key.escape) {
      suggestionConsumedRef.current = false  // 清理防双触发标记，防止 ref 残留影响后续 Enter
      setInputValue('')
    }
  }, { isActive: suggestions.length > 0 })

  // ModelPicker Esc 保险：在 App 层面直接监听 Esc。
  // useCallback 空依赖使 handler 引用永远稳定 → Ink 不会重复注册/注销，
  // 彻底消除重渲染期间按键丢失的竞态窗口（setShowModelPicker 是 React setter，永远稳定）
  const handleModelPickerKey = useCallback((input: string, key: { escape: boolean }) => {
    if (key.escape || input === 'q') setShowModelPicker(false)
  }, [])
  useInput(handleModelPickerKey, { isActive: showModelPicker })

  return (
    <Box flexDirection="column" width="100%">
      {started ? (
        <ChatView messages={messages} streamingMessage={streamingMessage} toolEvents={toolEvents} />
      ) : (
        <WelcomeScreen model={currentModel} provider={currentProvider} cwd={cwd} recentSessions={recentSessions} />
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
      ) : mcpLoading || mcpServers != null ? (
        mcpServers != null ? (
          <McpStatusView
            servers={mcpServers}
            onClose={() => { setMcpServers(null); setMcpLoading(false) }}
          />
        ) : (
          <Box paddingX={2} paddingY={1}>
            <Text dimColor>MCP Server 连接中...</Text>
          </Box>
        )
      ) : showResumePanel ? (
        <ResumePanel
          currentProjectSessions={currentProjectSessions}
          allSessions={allSessions}
          onSelect={(sessionId) => {
            loadSession(sessionId)
            setShowResumePanel(false)
          }}
          onClose={() => setShowResumePanel(false)}
        />
      ) : (
        <InputBar
          key={inputResetKey}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          disabled={isStreaming}
        />
      )}

      {suggestions.length > 0 && (
        <CommandSuggestion items={suggestions} selectedIndex={suggestionIndex} />
      )}
    </Box>
  )
}

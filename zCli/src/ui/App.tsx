// src/ui/App.tsx
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { WelcomeScreen } from './WelcomeScreen.js'
import { ChatView } from './ChatView.js'
import { InputBar } from './InputBar.js'
import { PermissionDialog } from './PermissionDialog.js'
import { UserQuestionForm } from './UserQuestionForm.js'
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
import { ForkCommand } from '@commands/fork.js'
import { UsageCommand } from '@commands/usage.js'
import { GcCommand } from '@commands/gc.js'
import { SkillsCommand } from '@commands/skills.js'
import { getCleanupStats, executeCleanup } from '@core/cleanup-service.js'
import { McpStatusView } from './McpStatusView.js'
import { ResumePanel } from './ResumePanel.js'
import { ForkPanel } from './ForkPanel.js'
import type { ServerInfo } from '@mcp/mcp-manager.js'
import { sessionStore, toProjectSlug } from '@persistence/index.js'
import { tokenMeter } from './useChat.js'
import { skillStore, ensureSkillsDiscovered } from '@core/bootstrap.js'

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
    subAgentEvents,
    isStreaming,
    error,
    submit,
    abort,
    interruptAndSubmit,
    pendingPermission,
    pendingQuestion,
    resolvePermission,
    resolveQuestion,
    currentProvider,
    currentModel,
    clearMessages,
    appendSystemMessage,
    switchModel,
    getMcpInfo,
    loadSession,
    forkFromEvent,
  } = useChat()

  const [showModelPicker, setShowModelPicker] = useState(false)
  /** /mcp 指令触发后填充，展示 MCP Server 状态 */
  const [mcpServers, setMcpServers] = useState<ServerInfo[] | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  // Tab 补全后递增，使 InputBar key 变化以强制重挂载，确保 cursor 归位到末尾
  const [inputResetKey, setInputResetKey] = useState(0)
  // suggestionIndexRef: useInput 回调内读取最新索引值（避免闭包捕获陈旧 state）
  const suggestionIndexRef = useRef(0)
  // suggestionsRef: handleSubmit 内读取最新建议列表（避免 useCallback 闭包陈旧）
  const suggestionsRef = useRef<SuggestionItem[]>([])
  /** /mcp 面板是否正在加载中 */
  const [mcpLoading, setMcpLoading] = useState(false)
  /** /resume 面板是否显示 */
  const [showResumePanel, setShowResumePanel] = useState(false)
  /** /fork 面板是否显示 */
  const [showForkPanel, setShowForkPanel] = useState(false)

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

  /** 获取 session 的分支列表（用于 ResumePanel 分支视图） */
  const getBranches = useCallback((sessionId: string) => {
    try {
      return sessionStore.listBranches(sessionId)
    } catch {
      return []
    }
  }, [])

  const started = messages.length > 0 || isStreaming

  // 对话开始时清屏：WelcomeScreen 已写入终端的内容不会被 Ink 自动移除，
  // 需要手动清屏让 ChatView 从干净的终端开始渲染
  const hasClearedRef = useRef(false)
  useEffect(() => {
    if (started && !hasClearedRef.current) {
      hasClearedRef.current = true
      process.stdout.write('\x1b[2J\x1b[H')
    }
  }, [started])

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

  // 启动时发现 Skills（幂等），使 / 建议浮层立即可用
  const [skillsReady, setSkillsReady] = useState(false)
  useEffect(() => {
    ensureSkillsDiscovered().then(() => setSkillsReady(true))
  }, [])

  // CommandRegistry — 当 provider/model 变化时重建，确保 /model 指令能感知当前状态
  const registry = useMemo(() => {
    const reg = new CommandRegistry()
    reg.register(new ClearCommand())
    reg.register(new HelpCommand(() => reg.getAll()))
    reg.register(new ModelCommand(currentProvider, currentModel))
    reg.register(new McpCommand())
    reg.register(new ResumeCommand())
    reg.register(new ForkCommand())
    reg.register(new UsageCommand())
    reg.register(new GcCommand())
    reg.register(new SkillsCommand())
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

    // 常规指令
    const cmdItems: SuggestionItem[] = registry.getAll()
      .filter(cmd => cmd.name.startsWith(query) || cmd.aliases?.some(a => a.startsWith(query)))

    // Skills 也作为建议项混入
    const skillItems: SuggestionItem[] = skillStore.getAll()
      .filter(s => (s.userInvocable ?? true) && s.name.startsWith(query))
      .map(s => ({ name: s.name, description: s.description, source: s.source }))

    return [...cmdItems, ...skillItems]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, registry, skillsReady])
  suggestionsRef.current = suggestions

  // inputValue 变化时重置高亮索引，避免越界
  useEffect(() => {
    setSuggestionIndex(0)
    suggestionIndexRef.current = 0  // 同步 ref，供 useInput 闭包读取
  }, [inputValue])

  const handleSubmit = useCallback((input: string) => {
    setInputValue('')
    let trimmed = input.trim()

    // 建议浮层可见时，使用当前选中的建议项替代原始输入
    // （用户可能只输入了 / 或 /h，但方向键选中了 /hello-world）
    // 必须在 guard 之前，否则纯 "/" 输入会被提前过滤
    const activeSuggestions = suggestionsRef.current
    if (activeSuggestions.length > 0 && trimmed.startsWith('/')) {
      const selected = activeSuggestions[suggestionIndexRef.current]
      if (selected) {
        trimmed = '/' + selected.name
      }
    }

    if (!trimmed || trimmed === '/') return

    // /exit 和 /quit 不通过 CommandRegistry，直接退出应用
    if (trimmed === '/exit' || trimmed === '/quit') {
      exit()
      return
    }

    // 斜杠指令分发（含 skill fallback）
    const result = registry.dispatch(trimmed)

    // Skill fallback：registry 不认识的 /xxx 命令，检查是否是 skill 名称
    // /commit → 提交用户消息让 LLM 调用 skill 工具
    // /commit <args> → 带参数的 skill 调用
    if (result.handled && result.action?.type === 'error' && trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/)
      const skillName = parts[0] ?? ''
      const skillArgs = parts.slice(1).join(' ')
      const matchedSkill = skillStore.getAll().find(s => s.name === skillName)
      if (matchedSkill) {
        const prompt = skillArgs
          ? `Use the "${skillName}" skill. ${skillArgs}`
          : `Use the "${skillName}" skill.`
        submit(prompt)
        return
      }
    }

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
          case 'show_usage': {
            const session = tokenMeter.getSessionStats()
            const todayRows = tokenMeter.getTodayStats()
            const monthRows = tokenMeter.getMonthStats()

            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
            const currencySymbol = (c: string) => c === 'CNY' ? '¥' : '$'
            const fmtCostMap = (m: Record<string, number>) => {
              const parts = Object.entries(m).filter(([, v]) => v > 0).map(([c, v]) => `${currencySymbol(c)}${v.toFixed(4)}`)
              return parts.length > 0 ? parts.join(' + ') : '--'
            }
            const fmtAggRows = (rows: Array<{ totalCost: number; currency: string }>) => {
              const parts = rows.filter(r => r.totalCost > 0).map(r => `${currencySymbol(r.currency)}${r.totalCost.toFixed(4)}`)
              return parts.length > 0 ? parts.join(' + ') : '--'
            }
            const sumTokens = (rows: Array<{ totalInputTokens: number; totalOutputTokens: number; callCount: number }>) => {
              let inp = 0, out = 0, calls = 0
              for (const r of rows) { inp += r.totalInputTokens; out += r.totalOutputTokens; calls += r.callCount }
              return { inp, out, calls }
            }
            const td = sumTokens(todayRows)
            const mt = sumTokens(monthRows)

            const text = [
              '── Token Usage ──',
              '',
              `本次会话:  ${fmt(session.totalInputTokens)} in / ${fmt(session.totalOutputTokens)} out | ${fmtCostMap(session.costByCurrency)} (${session.callCount} calls)`,
              `今日汇总:  ${fmt(td.inp)} in / ${fmt(td.out)} out | ${fmtAggRows(todayRows)} (${td.calls} calls)`,
              `本月汇总:  ${fmt(mt.inp)} in / ${fmt(mt.out)} out | ${fmtAggRows(monthRows)} (${mt.calls} calls)`,
            ].join('\n')
            appendSystemMessage(text)
            return
          }
          case 'run_gc': {
            const fmtSize = (bytes: number) => {
              if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
              if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
              return bytes + ' B'
            }

            const opts = {
              target: action.target,
              ...(action.days !== null ? { sessionRetentionDays: action.days, usageRetentionDays: action.days } : {}),
            }

            if (action.dryRun) {
              const stats = getCleanupStats(opts)
              const lines = [
                '── 数据清理预览 (dry-run) ──',
                '',
                `会话文件:  ${stats.sessions.totalFiles} 个文件, 共 ${fmtSize(stats.sessions.totalSizeBytes)}`,
                `  过期:    ${stats.sessions.expiredFiles} 个文件 (${fmtSize(stats.sessions.expiredSizeBytes)})`,
                '',
                `用量记录:  ${stats.usage.totalRows} 条`,
                `  过期:    ${stats.usage.expiredRows} 条`,
              ]
              appendSystemMessage(lines.join('\n'))
            } else {
              const stats = getCleanupStats(opts)
              if (stats.sessions.expiredFiles === 0 && stats.usage.expiredRows === 0) {
                appendSystemMessage('没有需要清理的过期数据。')
              } else {
                const result = executeCleanup(opts)
                const lines = ['── 清理完成 ──', '']
                if (result.deletedSessionFiles > 0) {
                  lines.push(`✓ 已清理 ${result.deletedSessionFiles} 个会话文件 (${fmtSize(result.deletedSessionBytes)})`)
                }
                if (result.deletedUsageRows > 0) {
                  lines.push(`✓ 已清理 ${result.deletedUsageRows} 条用量记录`)
                }
                appendSystemMessage(lines.join('\n'))
              }
            }
            return
          }
          case 'show_resume_panel':
            setShowResumePanel(true)
            return
          case 'show_fork_panel':
            setShowForkPanel(true)
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
          case 'list_skills':
            ensureSkillsDiscovered().then(() => {
              const skills = skillStore.getAll()
              if (skills.length === 0) {
                appendSystemMessage('No skills available.')
              } else {
                const lines = ['── Available Skills ──', '']
                for (const s of skills) {
                  const tag = s.source === 'builtin' ? ' [built-in]' : s.source === 'project' ? ' [project]' : ''
                  lines.push(`  ${s.name}${tag}  ${s.description}`)
                }
                lines.push('', 'Usage: /skills <name> to load a skill')
                appendSystemMessage(lines.join('\n'))
              }
            })
            return
          case 'load_skill':
            skillStore.getContent(action.name).then(content => {
              if (!content) {
                appendSystemMessage(`Skill "${action.name}" not found. Use /skills to list available skills.`)
              } else {
                appendSystemMessage(`── Skill loaded: ${action.name} ──\n\n${content}`)
              }
            })
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

  // 建议浮层按键：Arrow 导航、Tab 补全、Enter 提交选中项、Escape 取消
  useInput((_input, key) => {
    if (key.upArrow) {
      setSuggestionIndex(i => {
        const next = i <= 0 ? suggestions.length - 1 : i - 1
        suggestionIndexRef.current = next
        return next
      })
    }
    if (key.downArrow) {
      setSuggestionIndex(i => {
        const next = i >= suggestions.length - 1 ? 0 : i + 1
        suggestionIndexRef.current = next
        return next
      })
    }
    // Tab: 补全选中项到输入框（不提交，方便追加参数）
    if (key.tab) {
      const cmd = suggestions[suggestionIndexRef.current]
      if (cmd) {
        setInputValue('/' + cmd.name + ' ')
        setInputResetKey(k => k + 1)
      }
    }
    // Enter: 不拦截，透传给 TextInput.onSubmit → handleSubmit 通过 suggestionsRef 解析选中项
    if (key.escape) {
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

  // 双击 Ctrl+C 退出计时器（参照 Claude Code：第一次提示，第二次退出）
  const lastCtrlCRef = useRef(0)
  const DOUBLE_CTRLC_MS = 2000

  // Ctrl+C / Escape 全局处理
  useInput((input, key) => {
    const isCtrlC = input === 'c' && key.ctrl
    if (isStreaming && pendingPermission == null) {
      // streaming 期间：Escape 或 Ctrl+C 中断当前响应
      if (key.escape || isCtrlC) {
        abort()
        appendSystemMessage('⏹ 已中断响应')
      }
    } else if (isCtrlC && !isStreaming) {
      // 空闲时 Ctrl+C：双击退出
      const now = Date.now()
      if (now - lastCtrlCRef.current < DOUBLE_CTRLC_MS) {
        exit()
      } else {
        lastCtrlCRef.current = now
        appendSystemMessage('再次 Ctrl+C 退出')
      }
    }
  })

  return (
    <Box flexDirection="column" width="100%">
      {started ? (
        <ChatView messages={messages} streamingMessage={streamingMessage} toolEvents={toolEvents} subAgentEvents={subAgentEvents} />
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
      ) : pendingQuestion != null ? (
        <UserQuestionForm
          questions={pendingQuestion.questions}
          onResolve={resolveQuestion}
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
          getBranches={getBranches}
          hasCurrentSession
          onSelect={(sessionId, leafEventUuid) => {
            loadSession(sessionId, leafEventUuid)
            setShowResumePanel(false)
          }}
          onClose={() => setShowResumePanel(false)}
        />
      ) : showForkPanel ? (
        <ForkPanel
          messages={messages}
          onFork={(messageId) => {
            forkFromEvent(messageId)
            setShowForkPanel(false)
          }}
          onClose={() => setShowForkPanel(false)}
        />
      ) : (
        <>
          {started && !isStreaming && (() => {
            const s = tokenMeter.getSessionStats()
            if (s.callCount === 0) return null
            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
            const sym = (c: string) => c === 'CNY' ? '¥' : '$'
            const costParts = Object.entries(s.costByCurrency).filter(([, v]) => v > 0).map(([c, v]) => `${sym(c)}${v.toFixed(4)}`)
            const cost = costParts.length > 0 ? ` | ${costParts.join(' + ')}` : ''
            return (
              <Box paddingX={1}>
                <Text dimColor>{fmt(s.totalInputTokens)} in / {fmt(s.totalOutputTokens)} out{cost}</Text>
              </Box>
            )
          })()}
          {isStreaming && (
            <Box paddingX={1}>
              <Text dimColor>Esc to interrupt</Text>
            </Box>
          )}
          <InputBar
            key={inputResetKey}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            onInterruptSubmit={(text) => {
              setInputValue('')
              interruptAndSubmit(text)
            }}
            streaming={isStreaming}
          />
        </>
      )}

      {suggestions.length > 0 && (
        <CommandSuggestion items={suggestions} selectedIndex={suggestionIndex} />
      )}
    </Box>
  )
}

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
import { BridgeCommand } from '@commands/bridge.js'
import { SkillsCommand } from '@commands/skills.js'
import { CompactCommand } from '@commands/compact.js'
import { ContextCommand } from '@commands/context.js'
import { contextManager } from '@core/context-manager.js'
import { contextTracker } from '@core/context-tracker.js'
import { PluginsCommand } from '@commands/plugins.js'
import { RememberCommand } from '@commands/remember.js'
import { pluginRegistry } from '@core/bootstrap.js'
import { getCleanupStats, executeCleanup } from '@core/cleanup-service.js'
import { McpStatusView } from './McpStatusView.js'
import { ResumePanel } from './ResumePanel.js'
import { ForkPanel } from './ForkPanel.js'
import type { ServerInfo } from '@mcp/mcp-manager.js'
import { sessionStore, toProjectSlug } from '@persistence/index.js'
import { tokenMeter } from './useChat.js'
import { skillStore, fileIndex, bootstrapAll, getBootstrapStatus, startMcpBackground, getMcpTiming, isDevMode, getCurrentSessionId, getMemoryManager } from '@core/bootstrap.js'
import type { BootstrapTimings } from '@core/bootstrap.js'
import { AtResolver } from '@utils/at-resolver.js'
import { enterAlternateScreen } from './terminal-screen.js'
import { useTerminalSize } from './useTerminalSize.js'
import { AtSuggestion, createSearchItem, createBrowseItem } from './AtSuggestion.js'
import type { AtSuggestionItem } from './AtSuggestion.js'
import { TodoPanel, hasPendingTodos } from './TodoPanel.js'
import { SubAgentPanel } from './SubAgentPanel.js'
import { listSubAgents } from '@tools/agent/store.js'

/**
 * App — cCli 根组件
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
  webEnabled?: boolean | undefined
}

export function App({
  model: _model,
  provider: _provider,
  cwd = process.cwd(),
  resumeSessionId,
  showResumeOnStart,
  webEnabled,
}: AppProps) {
  const { exit } = useApp()
  // 订阅终端尺寸变化：debounce + 清屏，避免 Ink 差分渲染残留
  useTerminalSize()
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
    todos,
    contextState,
    clearMessages,
    appendSystemMessage,
    switchModel,
    getMcpInfo,
    loadSession,
    forkFromEvent,
    compactMessages,
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
  // @ 文件建议浮层状态
  const [atSuggestionIndex, setAtSuggestionIndex] = useState(0)
  const atSuggestionIndexRef = useRef(0)
  const atSuggestionsRef = useRef<AtSuggestionItem[]>([])
  /** /mcp 面板是否正在加载中 */
  const [mcpLoading, setMcpLoading] = useState(false)
  /** /resume 面板是否显示 */
  const [showResumePanel, setShowResumePanel] = useState(false)
  /** /fork 面板是否显示 */
  const [showForkPanel, setShowForkPanel] = useState(false)
  /** SubAgent 悬浮面板是否显示 */
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(false)

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
      /* 历史记录获取失败，使用空列表 */
      return []
    }
  }, [cwd])

  /** 获取 session 的分支列表（用于 ResumePanel 分支视图） */
  const getBranches = useCallback((sessionId: string) => {
    try {
      return sessionStore.listBranches(sessionId)
    } catch {
      /* 分支列表获取失败，使用空列表 */
      return []
    }
  }, [])

  const started = messages.length > 0 || isStreaming

  // 备用屏幕切换标记：首次进入对话时切换到备用屏幕缓冲区（和 vim/less 相同机制），
  // 在 handleSubmit / loadSession 中同步执行（状态变化前），
  // 避免 useEffect 时序问题（Ink <Static> 在 render 时冻结帧，useEffect 在 render 后才执行）
  const hasClearedRef = useRef(false)

  // Handle --resume CLI flag
  useEffect(() => {
    if (resumeSessionId) {
      // Direct resume by sessionId — 同步清屏
      if (!hasClearedRef.current) {
        hasClearedRef.current = true
        enterAlternateScreen()
      }
      loadSession(resumeSessionId)
    } else if (showResumeOnStart) {
      // Show resume panel
      setShowResumePanel(true)
    }
  }, []) // Only on mount

  // 启动时全量并行初始化（Skills / MCP / FileIndex / Instructions / Hooks / SystemPrompt）
  // 用户看 WelcomeScreen、打字的时间后台全速完成，首次 submit 零等待
  const [skillsReady, setSkillsReady] = useState(false)
  const [fileIndexReady, setFileIndexReady] = useState(false)
  const [bootTimings, setBootTimings] = useState<BootstrapTimings | null>(null)
  const [bootWarnings, setBootWarnings] = useState<string[]>([])
  const [mcpMs, setMcpMs] = useState<number | null>(null)
  useEffect(() => {
    // MCP 后台静默加载，就绪后回调更新 timing 显示
    startMcpBackground(() => setMcpMs(getMcpTiming()))
    bootstrapAll().then((result) => {
      const status = getBootstrapStatus()
      if (status.skillsReady) setSkillsReady(true)
      if (status.fileIndexReady) setFileIndexReady(true)
      // 设置插件 UI 桥接（bootstrap 完成后插件已激活）
      pluginRegistry.setBridge({
        injectInput: (text) => { setInputValue(text); setInputResetKey(k => k + 1) },
        submitInput: (text) => handleSubmit(text),
        appendSystemMessage,
        getSessionId: () => getCurrentSessionId(),
        getModel: () => currentModel,
        getProvider: () => currentProvider,
      })
      if (result.timings) setBootTimings(result.timings)
      // 降级/警告提示：短暂显示后消失
      if (result.warnings.length > 0) {
        setBootWarnings(result.warnings)
        setTimeout(() => setBootWarnings([]), 8000) // 8 秒后消失
      }
    })
  }, [])

  // AtResolver 实例（稳定引用）
  const atResolver = useMemo(() => new AtResolver(cwd), [cwd])

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
    reg.register(new BridgeCommand())
    reg.register(new CompactCommand())
    reg.register(new ContextCommand())
    reg.register(new PluginsCommand())
    reg.register(new RememberCommand())
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

  // 提取用户历史消息（从旧到新），用于 InputBar ↑↓ 翻阅
  const userHistory = useMemo(() => {
    return messages.filter(m => m.role === 'user').map(m => m.content)
  }, [messages])

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

    // 插件命令也混入建议
    const pluginItems: SuggestionItem[] = pluginRegistry.getCommands()
      .filter(c => c.name.startsWith(query))
      .map(c => ({ name: c.name, description: c.description, source: 'plugin' as const }))

    return [...cmdItems, ...skillItems, ...pluginItems]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, registry, skillsReady])
  suggestionsRef.current = suggestions

  // atSuggestions: 检测输入中最近的 @ 触发，驱动文件建议浮层
  // 两种模式：
  // - 浏览模式：query 为空或以 "/" 结尾 → listEntries() 展示目录内容
  // - 搜索模式：query 有文本 → search() 模糊匹配
  const atSuggestions: AtSuggestionItem[] = useMemo(() => {
    if (!fileIndexReady) return []
    const text = inputValue
    const idx = text.lastIndexOf('@')
    if (idx === -1) return []
    const before = idx === 0 ? ' ' : text[idx - 1]
    if (!before || !/\s/.test(before)) return []
    const after = text.slice(idx + 1)
    if (/\s/.test(after)) return []

    const query = after
    // 浏览模式：刚输入 @ 或 @dir/
    if (query.length === 0 || query.endsWith('/')) {
      const dirPrefix = query // "" 或 "src/" 等
      return fileIndex.listEntries(dirPrefix, 30).map(e =>
        createBrowseItem(e.name, e.fullPath, e.isDir)
      )
    }
    // 搜索模式：模糊匹配
    return fileIndex.search(query, 20).map(r => createSearchItem(r.path))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, fileIndexReady])
  atSuggestionsRef.current = atSuggestions

  // inputValue 变化时重置高亮索引，避免越界
  useEffect(() => {
    setSuggestionIndex(0)
    suggestionIndexRef.current = 0
    setAtSuggestionIndex(0)
    atSuggestionIndexRef.current = 0
  }, [inputValue])

  const handleSubmit = useCallback((input: string) => {
    setInputValue('')
    let trimmed = input.trim()

    // / 建议浮层可见时，使用当前选中的建议项替代原始输入
    // （用户可能只输入了 / 或 /h，但方向键选中了 /hello-world）
    // 必须在 guard 之前，否则纯 "/" 输入会被提前过滤
    const activeSuggestions = suggestionsRef.current
    if (activeSuggestions.length > 0 && trimmed.startsWith('/')) {
      const selected = activeSuggestions[suggestionIndexRef.current]
      if (selected) {
        trimmed = '/' + selected.name
      }
    }

    // @ 建议浮层可见时，Enter 行为：
    // - 选中目录 → 导航进入（追加目录路径，不加空格）
    // - 选中文件 → 补全完整路径并加空格
    const activeAtSuggestions = atSuggestionsRef.current
    if (activeAtSuggestions.length > 0 && activeSuggestions.length === 0) {
      const selected = activeAtSuggestions[atSuggestionIndexRef.current]
      if (selected) {
        const atIdx = input.lastIndexOf('@')
        if (atIdx !== -1) {
          if (selected.isDir) {
            // 目录：导航进入，@ 后跟完整目录路径
            setInputValue(input.slice(0, atIdx) + '@' + selected.path)
          } else {
            // 文件：补全路径 + 空格，结束 @ 模式
            setInputValue(input.slice(0, atIdx) + '@' + selected.path + ' ')
          }
          setInputResetKey(k => k + 1)
          return
        }
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
        if (!hasClearedRef.current) {
          hasClearedRef.current = true
          enterAlternateScreen()
        }
        submit(prompt)
        return
      }

      // Plugin command fallback：检查插件注册的命令
      const pluginCmds = pluginRegistry.getCommands()
      const pluginCmd = pluginCmds.find(c => {
        const cmdName = parts[0] ?? ''
        return c.name === cmdName || c.aliases?.includes(cmdName)
      })
      if (pluginCmd) {
        const cmdArgs = parts.slice(1)
        try {
          const result = pluginCmd.execute(cmdArgs)
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err: unknown) => {
              appendSystemMessage(`Plugin command error: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
        } catch (err: unknown) {
          appendSystemMessage(`Plugin command error: ${err instanceof Error ? err.message : String(err)}`)
        }
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
          case 'list_skills': {
            // bootstrapAll 已在 mount 时启动，此时 skills 大概率已就绪
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
          }
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
          case 'bridge_status': {
            const running = webEnabled ?? false
            if (running) {
              const sid = getCurrentSessionId()
              appendSystemMessage(`Bridge Server 运行中 (port 9800)\n当前 session: ${sid ?? '未创建'}\nWeb UI: http://localhost:9800/session/${sid ?? ''}`)
            } else {
              appendSystemMessage('Bridge Server 未启动。使用 --web 参数启动。')
            }
            return
          }
          case 'bridge_stop': {
            fetch('http://localhost:9800/api/bridge/stop', { method: 'POST' })
              .then(() => appendSystemMessage('Bridge Server 已关闭'))
              .catch(() => appendSystemMessage('Bridge Server 未运行或关闭失败'))
            return
          }
          case 'run_compact': {
            compactMessages({
              ...(action.strategy !== undefined ? { strategy: action.strategy } : {}),
              ...(action.focus !== undefined ? { focus: action.focus } : {}),
            })
            return
          }
          case 'show_context': {
            const s = contextTracker.getState()
            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
            const lines = [
              `── Context Window (${fmt(s.totalWindow)}) ──`,
              '',
              `Used:       ${fmt(s.lastInputTokens)} tokens  (${(s.usedPercentage * 100).toFixed(1)}%)`,
              `Available:  ${fmt(s.remaining)} tokens`,
              `Level:      ${s.level === 'normal' ? '✓ normal' : s.level === 'warning' ? '⚠ warning' : s.level === 'critical' ? '⚠ critical' : '✗ overflow'}`,
              '',
              `Window:     ${fmt(s.totalWindow)} total, ${fmt(s.outputReserve)} reserved for output`,
              `Effective:  ${fmt(s.effectiveWindow)}`,
              `Strategy:   ${contextManager.getStrategyName()}`,
            ]
            appendSystemMessage(lines.join('\n'))
            return
          }
          case 'list_plugins': {
            const plugins = pluginRegistry.list()
            if (plugins.length === 0) {
              appendSystemMessage('No runtime plugins loaded.\nPlace plugins in ~/.ccode/plugins/<name>/runtime/index.js')
            } else {
              const lines = ['── Runtime Plugins ──', '']
              for (const p of plugins) {
                const status = p.status === 'active' ? '✓' : '✗'
                const cmds = p.commands.length > 0 ? ` cmds: ${p.commands.join(', ')}` : ''
                const tools = p.tools.length > 0 ? ` tools: ${p.tools.join(', ')}` : ''
                lines.push(`  ${status} ${p.name} v${p.version} [${p.source}]${cmds}${tools}`)
                if (p.description) lines.push(`    ${p.description}`)
                if (p.error) lines.push(`    ✗ ${p.error}`)
              }
              appendSystemMessage(lines.join('\n'))
            }
            return
          }
          case 'memory_list': {
            const mm = getMemoryManager()
            if (!mm) { appendSystemMessage('记忆系统未初始化'); return }
            const scope = action.scope === 'global' || action.scope === 'project' ? action.scope : undefined
            mm.list(scope).then(entries => {
              if (entries.length === 0) {
                appendSystemMessage(scope ? `${scope} 范围无记忆条目` : '无记忆条目')
              } else {
                const lines = entries.map(e => `- **${e.title}** (${e.scope}) [${e.type}] ${e.tags.length > 0 ? `tags: ${e.tags.join(', ')}` : ''}`)
                appendSystemMessage(`记忆条目 (${entries.length}):\n${lines.join('\n')}`)
              }
            }).catch(e => appendSystemMessage(`列出记忆失败: ${e}`))
            return
          }
          case 'memory_search': {
            const mm = getMemoryManager()
            if (!mm) { appendSystemMessage('记忆系统未初始化'); return }
            mm.search({ query: action.query, topK: 10 }).then(results => {
              if (results.length === 0) {
                appendSystemMessage(`搜索"${action.query}"未找到相关记忆`)
              } else {
                const lines = results.map(r => `- **${r.entry.title}** (score: ${r.score.toFixed(2)}) — ${r.snippet.slice(0, 80)}...`)
                appendSystemMessage(`搜索"${action.query}"找到 ${results.length} 条:\n${lines.join('\n')}`)
              }
            }).catch(e => appendSystemMessage(`搜索记忆失败: ${e}`))
            return
          }
          case 'memory_delete': {
            const mm = getMemoryManager()
            if (!mm) { appendSystemMessage('记忆系统未初始化'); return }
            mm.delete(action.id).then(() => {
              appendSystemMessage(`已删除记忆: ${action.id}`)
            }).catch(e => appendSystemMessage(`删除失败: ${e}`))
            return
          }
          case 'memory_write': {
            const mm = getMemoryManager()
            if (!mm) { appendSystemMessage('记忆系统未初始化'); return }
            // 从内容提取标题（第一行或前 30 字符）
            const firstLine = action.content.split('\n')[0] ?? action.content
            const title = firstLine.length > 30 ? firstLine.slice(0, 27) + '...' : firstLine
            mm.write({
              scope: 'project',
              title,
              content: action.content,
              type: 'user',
              tags: [],
              source: 'user',
              filePath: '',
            }).then(entry => {
              appendSystemMessage(`已记住: ${entry.title} (${entry.scope}:${entry.id})`)
            }).catch(e => appendSystemMessage(`写入记忆失败: ${e}`))
            return
          }
          case 'memory_rebuild': {
            const mm = getMemoryManager()
            if (!mm) { appendSystemMessage('记忆系统未初始化'); return }
            appendSystemMessage('正在重建记忆索引...')
            mm.initialize().then(() => {
              appendSystemMessage('记忆索引重建完成')
            }).catch(e => appendSystemMessage(`重建失败: ${e}`))
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
    // 首次提交前切换到备用屏幕，避免 WelcomeScreen 残留被 Ink <Static> 冻结到输出中
    if (!hasClearedRef.current) {
      hasClearedRef.current = true
      enterAlternateScreen()
    }

    // @ 文件引用解析：如果输入包含 @path 引用，在消息前注入 file-references context
    const { context, rawInput } = atResolver.resolve(trimmed)
    const finalMessage = context ? `${context}\n\n${rawInput}` : rawInput
    submit(finalMessage)
  }, [registry, clearMessages, appendSystemMessage, switchModel, submit, modelItems, exit, getMcpInfo, atResolver])

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

  // @ 文件建议浮层按键：Arrow 导航、Tab 补全文件路径
  useInput((_input, key) => {
    if (key.upArrow) {
      setAtSuggestionIndex(i => {
        const next = i <= 0 ? atSuggestions.length - 1 : i - 1
        atSuggestionIndexRef.current = next
        return next
      })
    }
    if (key.downArrow) {
      setAtSuggestionIndex(i => {
        const next = i >= atSuggestions.length - 1 ? 0 : i + 1
        atSuggestionIndexRef.current = next
        return next
      })
    }
    // Tab: 补全选中项 — 目录导航进入，文件补全路径
    if (key.tab) {
      const item = atSuggestions[atSuggestionIndexRef.current]
      if (item) {
        const text = inputValue
        const atIdx = text.lastIndexOf('@')
        if (atIdx !== -1) {
          if (item.isDir) {
            setInputValue(text.slice(0, atIdx) + '@' + item.path)
          } else {
            setInputValue(text.slice(0, atIdx) + '@' + item.path + ' ')
          }
          setInputResetKey(k => k + 1)
        }
      }
    }
    if (key.escape) {
      setInputValue('')
    }
  }, { isActive: atSuggestions.length > 0 && suggestions.length === 0 })

  // ModelPicker Esc 保险：在 App 层面直接监听 Esc。
  // useCallback 空依赖使 handler 引用永远稳定 → Ink 不会重复注册/注销，
  // 彻底消除重渲染期间按键丢失的竞态窗口（setShowModelPicker 是 React setter，永远稳定）
  const handleModelPickerKey = useCallback((input: string, key: { escape: boolean }) => {
    if (key.escape || input === 'q') setShowModelPicker(false)
  }, [])
  useInput(handleModelPickerKey, { isActive: showModelPicker })

  // Ctrl+B 切换 SubAgent 面板（有子 Agent 时才响应）
  useInput((input, key) => {
    if (key.ctrl && input === 'b') {
      const agents = listSubAgents()
      if (agents.length > 0) {
        setShowSubAgentPanel(prev => !prev)
      }
    }
  })

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
        <>
          {bootTimings && (
            <Box paddingX={2}>
              <Text dimColor>
                {'bootstrap '}
                {`${bootTimings.total.toFixed(0)}ms`}
                {' (skills '}{bootTimings.skills.toFixed(0)}
                {' → hooks '}{bootTimings.hooks.toFixed(0)}
                {' → startHooks '}{bootTimings.sessionStartHooks.toFixed(0)}
                {' | fileIndex '}{bootTimings.fileIndex.toFixed(0)}
                {' | instructions '}{bootTimings.instructions.toFixed(0)}
                {'ms) mcp: '}{mcpMs != null ? `${mcpMs.toFixed(0)}ms` : 'loading...'}
              </Text>
            </Box>
          )}
          {bootWarnings.length > 0 && (
            <Box paddingX={2} flexDirection="column">
              {bootWarnings.map((w, i) => (
                <Text key={i} color="yellow">⚠ {w}</Text>
              ))}
            </Box>
          )}
          <WelcomeScreen model={currentModel} provider={currentProvider} cwd={cwd} recentSessions={recentSessions} />
        </>
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
            if (!hasClearedRef.current) {
              hasClearedRef.current = true
              enterAlternateScreen()
            }
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
      ) : showSubAgentPanel ? (
        <SubAgentPanel onClose={() => setShowSubAgentPanel(false)} />
      ) : (
        <>
          {started && !isStreaming && (() => {
            const s = tokenMeter.getSessionStats()
            if (s.callCount === 0) return null
            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
            const sym = (c: string) => c === 'CNY' ? '¥' : '$'
            const costParts = Object.entries(s.costByCurrency).filter(([, v]) => v > 0).map(([c, v]) => `${sym(c)}${v.toFixed(4)}`)
            const cost = costParts.length > 0 ? ` | ${costParts.join(' + ')}` : ''
            const ctxInfo = contextState
              ? ` | Context: ${(contextState.usedPercentage * 100).toFixed(0)}%`
              : ''
            const ctxColor = contextState?.level === 'overflow' ? 'red'
              : contextState?.level === 'critical' ? 'red'
              : contextState?.level === 'warning' ? 'yellow'
              : undefined
            return (
              <Box paddingX={1}>
                <Text dimColor>{fmt(s.totalInputTokens)} in / {fmt(s.totalOutputTokens)} out{cost}</Text>
                {contextState && (
                  <Text {...(ctxColor ? { color: ctxColor } : { dimColor: true })}>
                    {ctxInfo}
                  </Text>
                )}
              </Box>
            )
          })()}
          {isStreaming && (
            <Box paddingX={1}>
              <Text dimColor>Esc to interrupt</Text>
            </Box>
          )}
          {hasPendingTodos(todos) && <TodoPanel todos={todos} />}
          {subAgentEvents.some(e => e.status === 'running') && (
            <Box paddingX={1}>
              <Text dimColor>{subAgentEvents.filter(e => e.status === 'running').length} agent(s) running  </Text>
              <Text color="cyan">Ctrl+B</Text>
              <Text dimColor> to view</Text>
            </Box>
          )}
          {webEnabled && (
            <Box paddingX={1}>
              <Text dimColor>Web UI: </Text>
              <Text color="cyan">{`http://localhost:9800/session/${getCurrentSessionId() ?? ''}`}</Text>
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
            history={userHistory}
          />
        </>
      )}

      {suggestions.length > 0 && (
        <CommandSuggestion items={suggestions} selectedIndex={suggestionIndex} />
      )}

      {atSuggestions.length > 0 && suggestions.length === 0 && (
        <AtSuggestion items={atSuggestions} selectedIndex={atSuggestionIndex} />
      )}
    </Box>
  )
}

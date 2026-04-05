// src/ui/useChat.ts

/**
 * useChat — 核心业务 hook，管理对话状态与 AgentLoop 生命周期。
 *
 * 职责：
 * - 维护消息列表（ChatMessage[]）、流式内容、工具事件、错误信息
 * - 管理当前 provider/model（session 级，不持久化到 config）
 * - 驱动 AgentLoop：发起请求、处理事件流、暂停等待权限确认
 * - 提供 clearMessages / appendSystemMessage / switchModel 供指令系统调用
 * - 自动持久化对话到 session JSONL 文件（additive，不影响已有功能）
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { randomUUID } from 'node:crypto'
import { configManager } from '@config/config-manager.js'
import { getOrCreateProvider } from '@providers/registry.js'
import { AgentLoop, isAbortError } from '@core/agent-loop.js'
import {
  sessionLogger, tokenMeter, getCurrentSessionId,
  getRegistry, registerMcpTools, getMcpStatus,
  hookManager,
  getSystemPrompt,
  bootstrapAll,
} from '@core/bootstrap.js'
import type { ChatMessage } from './ChatView.js'
import type { Message } from '@core/types.js'
import type { UserQuestion, UserQuestionResult } from '@core/agent-loop.js'
import type { ToolEvent, SubAgentEvent } from './ToolStatusLine.js'
import type { ServerInfo } from '@mcp/mcp-manager.js'
import { sessionStore, generateEventId } from '@persistence/index.js'
import { getTodos } from '@tools/ext/todo-store.js'
import { PermissionManager } from '@config/permissions.js'
import { eventBus } from '@core/event-bus.js'
import { contextTracker } from '@core/context-tracker.js'
import type { ContextWindowState } from '@core/context-tracker.js'
import { contextManager } from '@core/context-manager.js'
import { updateBridgeSession, isBridgeConnected } from '@server/bridge/client.js'

// 从 bootstrap 重导出，供 bin/ccli.ts 和 App.tsx 使用
export { sessionLogger, tokenMeter, getCurrentSessionId }

/** 待用户确认的权限请求，暂停 AgentLoop 直到 resolve 被调用 */
interface PendingPermission {
  toolName: string
  args: Record<string, unknown>
  /** 调用 resolve(true) 允许，resolve(false) 拒绝 */
  resolve: (allow: boolean) => void
}

/** 待用户回答的问题表单，暂停 AgentLoop 直到 resolve 被调用 */
interface PendingQuestion {
  questions: UserQuestion[]
  resolve: (result: UserQuestionResult) => void
}

/** useChat 的完整返回接口 */
export interface UseChatReturn {
  messages: ChatMessage[]
  /** null = 空闲；'' = 等待首 token；非空 = 流式内容累积中 */
  streamingMessage: string | null
  toolEvents: ToolEvent[]
  /** SubAgent 进度事件（动态区实时显示） */
  subAgentEvents: SubAgentEvent[]
  isStreaming: boolean
  error: string | null
  pendingPermission: PendingPermission | null
  /** 待用户回答的问题表单 */
  pendingQuestion: PendingQuestion | null
  /** session 级工具白名单（选择"always"后写入） */
  allowedTools: Set<string>
  currentProvider: string
  currentModel: string
  /** 当前任务计划列表（todo_write 工具写入，session 级） */
  todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }>
  /** 上下文窗口状态（每次 LLM 调用后更新） */
  contextState: ContextWindowState | null
  /** 发送用户消息，启动 AgentLoop */
  submit: (text: string) => void
  /** 中止当前流式请求 */
  abort: () => void
  /** 中断当前流式请求并发送新消息 */
  interruptAndSubmit: (text: string) => void
  /**
   * 解决权限确认。
   * @param allow  是否允许工具执行
   * @param always 是否将工具加入 session 白名单
   */
  resolvePermission: (allow: boolean, always?: boolean) => void
  /** 解决问题表单回答 */
  resolveQuestion: (result: UserQuestionResult) => void
  /** 清空所有消息（/clear 指令调用） */
  clearMessages: () => void
  /** 追加 system 角色消息，仅用于 UI 展示，不发送给 LLM */
  appendSystemMessage: (text: string) => void
  /** 切换 provider 和 model（session 级，不写回 config.json） */
  switchModel: (provider: string, model: string) => void
  /** 初始化 MCP 并返回状态信息（用于 /mcp 指令，会主动触发连接） */
  getMcpInfo: () => Promise<ServerInfo[]>
  /** 加载历史 session 并恢复消息（/resume 指令用），可指定分支叶节点 */
  loadSession: (sessionId: string, leafEventUuid?: string) => void
  /** 从指定消息处分叉（message.id = event uuid） */
  forkFromEvent: (messageId: string) => void
  /** 压缩对话上下文 */
  compactMessages: (options?: { strategy?: string; focus?: string }) => Promise<void>
  /** 历史累计运行时长 ms（跨 resume） */
  accumulatedMs: number
  /** 本次 session 启动时间戳 */
  sessionStartTime: number
}


/**
 * 核心对话 hook。
 * 所有 UI 组件通过此 hook 访问对话状态，不直接调用 AgentLoop 或 Provider。
 */
export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [subAgentEvents, setSubAgentEvents] = useState<SubAgentEvent[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set())
  const [currentProvider, setCurrentProvider] = useState<string>(() => configManager.load().defaultProvider ?? '')
  const [currentModel, setCurrentModel] = useState<string>(() => configManager.load().defaultModel ?? '')
  const [todos, setTodosState] = useState<Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }>>([])
  const [contextState, setContextState] = useState<ContextWindowState | null>(null)
  const [accumulatedMs, setAccumulatedMs] = useState(0)
  const [sessionStartTime] = useState(() => Date.now())

  // useRef 双轨：xxxRef 供 async 回调读取最新值（避免闭包捕获陈旧 state）；
  // 对应的 state 驱动 UI 重渲染
  const allowedToolsRef = useRef<Set<string>>(new Set())
  const toolEventsRef = useRef<ToolEvent[]>([])
  const abortRef = useRef<AbortController | null>(null)

  // 项目级权限白名单（lazy 初始化：首次 submit 时基于实际注册工具构建）
  const permissionManagerRef = useRef<PermissionManager | null>(null)

  // 组件卸载时自动中止进行中的流式请求，防止更新已卸载组件的状态
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  // 预创建 session（不等首次 submit），让 Bridge Server 连接时就能拿到 sessionId
  // ensureSession 幂等：后续 submit 调用不会重复创建
  useEffect(() => {
    if (currentProvider && currentModel) {
      sessionLogger.ensureSession(currentProvider, currentModel)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 订阅 eventBus 上的后台 subagent 事件（run_in_background 模式不经过 AgentLoop yield）
  useEffect(() => {
    const unsub = eventBus.on((event) => {
      if (event.type === 'subagent_progress') {
        setSubAgentEvents(prev => {
          const idx = prev.findIndex(e => e.agentId === event.agentId)
          const updated: SubAgentEvent = {
            id: event.agentId,
            agentId: event.agentId,
            name: event.name,
            agentType: event.agentType,
            description: event.description,
            status: 'running',
            turn: event.turn,
            maxTurns: event.maxTurns,
            ...(event.currentTool !== undefined ? { currentTool: event.currentTool } : {}),
          }
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = updated
            return next
          }
          return [...prev, updated]
        })
      } else if (event.type === 'subagent_done') {
        setSubAgentEvents(prev =>
          prev.map(e => e.agentId === event.agentId
            ? { ...e, status: 'done' as const, durationMs: Date.now() - (e.durationMs ?? 0) }
            : e
          )
        )
      }
    })
    return unsub
  }, [])


  /**
   * 处理权限确认结果。
   * always=true 时同步更新 ref（立即生效）和 state（触发重渲染）。
   */
  const resolvePermission = useCallback((allow: boolean, always = false) => {
    setPendingPermission(prev => {
      if (!prev) return null
      if (allow && always) {
        const newSet = new Set([...allowedToolsRef.current, prev.toolName])
        allowedToolsRef.current = newSet
        setAllowedTools(newSet)
      }
      prev.resolve(allow)
      return null
    })
  }, [])

  /**
   * 处理用户问题表单回答。
   */
  const resolveQuestion = useCallback((result: UserQuestionResult) => {
    setPendingQuestion(prev => {
      if (!prev) return null
      prev.resolve(result)
      return null
    })
  }, [])

  /**
   * 发送用户消息并启动 AgentLoop。
   * system 消息在构建 history 前被过滤，不发送给 LLM。
   */
  const submit = useCallback((text: string, _source: 'cli' | 'web' = 'cli') => {
    if (isStreaming) return

    const config = configManager.load()
    // 使用 state 中的 provider/model（可能已通过 /model 切换，与 config 文件不同）
    const globalProvider = getOrCreateProvider(currentProvider, config)
    const provider = globalProvider.createSession?.() ?? globalProvider
    const registry = getRegistry()

    // 首次 submit 时基于实际注册工具构建权限管理器
    if (!permissionManagerRef.current) {
      const toolNames = registry.getAll().map(t => t.name)
      permissionManagerRef.current = PermissionManager.fromProjectDir(process.cwd(), toolNames)
    }

    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', content: text }

    // LLM history 由 ContextManager 管理（完整的结构化 Message[]），
    // 不再从 UI 的 ChatMessage[] 重建——ChatMessage 是渲染模型，有损转换会丢失工具过程。
    contextManager.pushUser(text)

    setMessages(prev => [...prev, userMsg])
    // 只有 CLI 端直接输入时广播（Web 端触发的 submit 已由 EventBus 广播过）
    if (_source === 'cli') {
      eventBus.emit({ type: 'user_input', text, source: 'cli' })
    }
    setStreamingMessage('')
    toolEventsRef.current = []
    setToolEvents([])
    setSubAgentEvents([])
    setIsStreaming(true)
    setError(null)

    const controller = new AbortController()
    // 主 Agent 多轮 LLM 调用 + 并行 SubAgent，每次 provider.chat() 都给 signal 加 listener，
    // 默认 MaxListeners=10 在长会话中不够用，提高上限避免 Node.js 误报内存泄漏警告
    import('node:events').then(({ setMaxListeners }) => setMaxListeners(200, controller.signal)).catch(() => {})
    abortRef.current = controller

    // toolCallId → eventId 映射，保证多次调用同名工具时状态更新精确匹配
    const pendingToolIds = new Map<string, string>()

    ;(async () => {
      let accumulated = ''
      // 本轮统计变量
      let thinkingAccumulated = ''
      let turnInputTokens = 0
      let turnOutputTokens = 0
      let turnCacheReadTokens = 0
      let turnCacheWriteTokens = 0
      let turnToolCallCount = 0
      let turnLlmCallCount = 0
      let lastStopReason = ''
      try {
        // 确保 session 已创建，记录用户消息
        const sid = sessionLogger.ensureSession(currentProvider, currentModel)
        if (sid) tokenMeter.bind(sid, currentProvider, currentModel)
        sessionLogger.logUserMessage(text)

        // 等待核心模块就绪（App mount 时已启动，此处大概率已完成）
        // MCP 后台加载，已就绪则注册工具，未就绪不阻塞对话
        await bootstrapAll()
        registerMcpTools(registry)
        const systemPrompt = getSystemPrompt()

        // 上下文管理：auto-compact 检查 + tool 结果裁剪
        // history 来自 ContextManager（完整结构化 Message[]），不从 UI ChatMessage 重建
        const historyRef = contextManager.getHistoryRef()
        const { compacted } = await contextManager.prepare(
          historyRef, provider, { model: currentModel, ...(systemPrompt !== undefined ? { systemPrompt } : {}) },
        )
        if (compacted) {
          // auto-compact 触发：ContextManager 内部已通过 prepare 更新，UI 侧同步
          const compactedMsgs: ChatMessage[] = historyRef.map(m => ({
            id: randomUUID(),
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }))
          setMessages(compactedMsgs)
        }

        const loop = new AgentLoop(provider, registry, {
          model: currentModel,
          provider: currentProvider,
          signal: controller.signal,
          hookManager,
          config,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(sid ? { sessionId: sid } : {}),
        })

        for await (const event of loop.run(historyRef)) {
          // F9: 观测日志记录
          sessionLogger.consume(event)
          // F10: token 计量
          tokenMeter.consume(event)
          // 广播到 EventBus（CLI/Web 共享事件流）
          // 但跳过会被白名单自动放行的 permission_request——
          // 避免 Web 端收到一个"已经被 CLI 自动解决"的权限弹窗
          const skipBroadcast = event.type === 'permission_request' && (
            permissionManagerRef.current?.isAllowed(event.toolName) ||
            allowedToolsRef.current.has(event.toolName)
          )
          if (!skipBroadcast) eventBus.emit(event)

          if (event.type === 'thinking') {
            thinkingAccumulated += event.text
          } else if (event.type === 'llm_done') {
            // 累积本轮 token 统计
            turnInputTokens += event.inputTokens
            turnOutputTokens += event.outputTokens
            turnCacheReadTokens += event.cacheReadTokens
            turnCacheWriteTokens += event.cacheWriteTokens
            turnLlmCallCount++
            lastStopReason = event.stopReason
            // 广播上下文窗口状态（context-tracker 已在 agent-loop 中更新）
            const ctxState = contextTracker.getState()
            setContextState(ctxState)
            eventBus.emit({
              type: 'context_update',
              usedPercentage: ctxState.usedPercentage,
              lastInputTokens: ctxState.lastInputTokens,
              effectiveWindow: ctxState.effectiveWindow,
              level: ctxState.level,
            })
          } else if (event.type === 'text') {
            accumulated += event.text
            setStreamingMessage(accumulated)
          } else if (event.type === 'tool_start') {
            const id = randomUUID()
            pendingToolIds.set(event.toolCallId, id)
            const newEvent: ToolEvent = { id, toolName: event.toolName, args: event.args, status: 'running' }
            toolEventsRef.current = [...toolEventsRef.current, newEvent]
            setToolEvents(toolEventsRef.current)
          } else if (event.type === 'tool_done') {
            turnToolCallCount++
            const matchId = pendingToolIds.get(event.toolCallId)
            if (matchId) pendingToolIds.delete(event.toolCallId)

            // 从 toolEvents 中查找对应的 running 事件，获取 args
            const matchedEvent = toolEventsRef.current.find(e => e.id === matchId)

            // 从动态区移除已完成的工具（动态区只保留 running 状态）
            toolEventsRef.current = toolEventsRef.current.filter(e => e.id !== matchId)
            setToolEvents(toolEventsRef.current)

            // 写入 messages 历史（Static 永久显示）
            const toolMsg: ChatMessage = {
              id: matchId ?? randomUUID(),
              role: 'tool',
              content: '',
              toolCall: {
                toolName: event.toolName,
                args: matchedEvent?.args ?? {},
                durationMs: event.durationMs,
                success: event.success,
                ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
                ...(event.resultFull !== undefined ? { resultFull: event.resultFull } : {}),
                ...(event.meta !== undefined ? { meta: event.meta } : {}),
              },
            }
            setMessages(prev => [...prev, toolMsg])

            // todo_write 完成后：同步更新 todos 状态并广播 todo_update 事件
            if (event.toolName === 'todo_write') {
              const currentTodos = getTodos()
              setTodosState(currentTodos)
              eventBus.emit({ type: 'todo_update', todos: currentTodos })
            }
          } else if (event.type === 'subagent_progress') {
            // SubAgent 进度：按 agentId 更新或新增
            setSubAgentEvents(prev => {
              const idx = prev.findIndex(e => e.agentId === event.agentId)
              const updated: SubAgentEvent = {
                id: event.agentId,
                agentId: event.agentId,
                name: event.name,
                agentType: event.agentType,
                description: event.description,
                status: 'running',
                turn: event.turn,
                maxTurns: event.maxTurns,
                ...(event.currentTool !== undefined ? { currentTool: event.currentTool } : {}),
              }
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = updated
                return next
              }
              return [...prev, updated]
            })
          } else if (event.type === 'user_question_request') {
            // AskUserQuestion 工具：暂停等待用户填写表单
            setPendingQuestion({ questions: event.questions, resolve: event.resolve })
          } else if (event.type === 'permission_request') {
            // 权限检查优先级：项目级白名单 → session 级白名单 → 弹窗询问
            if (permissionManagerRef.current?.isAllowed(event.toolName)) {
              event.resolve(true)
            } else if (allowedToolsRef.current.has(event.toolName)) {
              event.resolve(true)
            } else {
              setPendingPermission({ toolName: event.toolName, args: event.args, resolve: event.resolve })
            }
          } else if (event.type === 'error') {
            setError(event.error)
            break
          } else if (event.type === 'done') {
            break
          }
        }

        if (accumulated) {
          const assistantMsg: ChatMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: accumulated,
            model: currentModel,
            provider: currentProvider,
            ...(thinkingAccumulated ? { thinking: thinkingAccumulated } : {}),
          }
          setMessages(prev => [...prev, assistantMsg])
          // F9: 记录助手回复（携带本轮统计元数据）
          sessionLogger.logAssistantMessage(accumulated, currentModel, currentProvider, {
            ...(turnInputTokens > 0 ? { usage: { inputTokens: turnInputTokens, outputTokens: turnOutputTokens, cacheReadTokens: turnCacheReadTokens, cacheWriteTokens: turnCacheWriteTokens } } : {}),
            ...(lastStopReason ? { stopReason: lastStopReason } : {}),
            ...(turnLlmCallCount > 0 ? { llmCallCount: turnLlmCallCount } : {}),
            ...(turnToolCallCount > 0 ? { toolCallCount: turnToolCallCount } : {}),
            ...(thinkingAccumulated ? { thinking: thinkingAccumulated } : {}),
          })
        }
      } catch (err) {
        if (isAbortError(err)) {
          // 用户中断：保存已累积的部分回复
          if (accumulated) {
            const partialMsg: ChatMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: accumulated,
              model: currentModel,
              provider: currentProvider,
              ...(thinkingAccumulated ? { thinking: thinkingAccumulated } : {}),
            }
            setMessages(prev => [...prev, partialMsg])
            sessionLogger.logAssistantMessage(accumulated, currentModel, currentProvider, {
              ...(turnInputTokens > 0 ? { usage: { inputTokens: turnInputTokens, outputTokens: turnOutputTokens, cacheReadTokens: turnCacheReadTokens, cacheWriteTokens: turnCacheWriteTokens } } : {}),
              ...(lastStopReason ? { stopReason: lastStopReason } : {}),
              ...(turnLlmCallCount > 0 ? { llmCallCount: turnLlmCallCount } : {}),
              ...(turnToolCallCount > 0 ? { toolCallCount: turnToolCallCount } : {}),
              ...(thinkingAccumulated ? { thinking: thinkingAccumulated } : {}),
            })
          }
          // 按 Claude Code 模式记录中断消息
          sessionLogger.logUserMessage('[Request interrupted by user]')
        } else {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        provider.dispose?.()
        setStreamingMessage(null)
        setIsStreaming(false)
        abortRef.current = null
      }
    })()
  }, [isStreaming, messages, currentProvider, currentModel])

  /** 中止当前 AgentLoop 请求（用户主动取消或超时） */
  const abort = useCallback(() => { abortRef.current?.abort() }, [])

  /** 中断当前流并提交新消息 */
  const interruptAndSubmit = useCallback((text: string) => {
    abortRef.current?.abort()
    setTimeout(() => submit(text), 0)
  }, [submit])

  /** 清空消息列表（/clear 指令） */
  const clearMessages = useCallback((): void => {
    setMessages([])
    contextManager.clearHistory()
  }, [])

  /** 追加 UI 专用的 system 消息（不发送给 LLM） */
  const appendSystemMessage = useCallback((text: string): void => {
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      content: text,
    }
    setMessages(prev => [...prev, msg])
  }, [])

  /** 切换当前 provider 和 model（session 级，下次 submit 生效） */
  const switchModel = useCallback((provider: string, model: string): void => {
    setCurrentProvider(provider)
    setCurrentModel(model)
  }, [])

  /** 初始化 MCP 并返回所有 Server 状态（/mcp 指令用，会主动触发连接） */
  const getMcpInfo = useCallback(async (): Promise<ServerInfo[]> => {
    return getMcpStatus()
  }, [])

  /** 加载历史 session，恢复消息列表和 provider/model，可指定分支叶节点 */
  const loadSession = useCallback((sessionId: string, leafEventUuid?: string): void => {
    try {
      const snapshot = sessionStore.loadMessages(sessionId, leafEventUuid)

      // 绑定 SessionLogger 到恢复的会话
      sessionLogger.bind(sessionId, snapshot.leafEventUuid)

      // 提取历史累计时长
      const lastAccMs = sessionStore.getLastAccumulatedMs(sessionId)
      setAccumulatedMs(lastAccMs)
      sessionLogger.setAccumulatedMs(lastAccMs)

      // 恢复消息列表（UI）
      const restored: ChatMessage[] = snapshot.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
      }))
      setMessages(restored)

      // 恢复 LLM history（ContextManager）
      const structuredHistory: Message[] = snapshot.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      contextManager.restoreHistory(structuredHistory)

      // 恢复 provider/model
      if (snapshot.provider) setCurrentProvider(snapshot.provider)
      if (snapshot.model) setCurrentModel(snapshot.model)

      // 追加 session_resume 事件
      const resumeEventId = generateEventId()
      sessionStore.append(sessionId, {
        sessionId,
        type: 'session_resume',
        timestamp: new Date().toISOString(),
        uuid: resumeEventId,
        parentUuid: sessionLogger.lastEventUuid,
        cwd: process.cwd(),
        provider: snapshot.provider,
        model: snapshot.model,
        accumulatedMs: lastAccMs,
      })
      // 更新 logger 的 lastEventUuid
      sessionLogger.bind(sessionId, resumeEventId)

      // 通知 Bridge 客户端切换到新 sessionId（Web 端感知 CLI 回来了）
      if (isBridgeConnected()) {
        updateBridgeSession(sessionId)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendSystemMessage(`Failed to load session: ${msg}`)
    }
  }, [appendSystemMessage])

  /** 从指定消息处分叉，截断消息列表并开始新分支 */
  const forkFromEvent = useCallback((messageId: string): void => {
    const sid = sessionLogger.sessionId
    if (!sid) {
      appendSystemMessage('No active session to fork from')
      return
    }

    try {
      // 从分叉点重新加载消息
      const snapshot = sessionStore.loadMessages(sid, messageId)

      // 恢复消息到分叉点
      const restored: ChatMessage[] = snapshot.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
      }))
      setMessages(restored)

      // 恢复 LLM history（ContextManager）
      const structuredHistory: Message[] = snapshot.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      contextManager.restoreHistory(structuredHistory)

      // 将 lastEventUuid 设为分叉点，后续消息将从此处分支
      sessionLogger.bind(sid, messageId)

      // 追加 session_resume 事件标记分叉
      const resumeEventId = generateEventId()
      sessionStore.append(sid, {
        sessionId: sid,
        type: 'session_resume',
        timestamp: new Date().toISOString(),
        uuid: resumeEventId,
        parentUuid: messageId, // 分叉点！
        cwd: process.cwd(),
        provider: currentProvider,
        model: currentModel,
        accumulatedMs: 0, // 分叉时重置时间
      })
      sessionLogger.bind(sid, resumeEventId)

      appendSystemMessage('Forked from message — new branch started. Continue typing to diverge.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendSystemMessage(`Failed to fork: ${msg}`)
    }
  }, [appendSystemMessage, currentProvider, currentModel])

  /** 压缩对话上下文 */
  const compactMessages = useCallback(async (options?: { strategy?: string; focus?: string }) => {
    if (isStreaming) return

    const config = configManager.load()
    const provider = getOrCreateProvider(currentProvider, config)

    // 从 ContextManager 取完整 history（不从 UI ChatMessage 重建）
    const history = contextManager.getHistoryRef()

    if (history.length === 0) {
      appendSystemMessage('No messages to compact.')
      return
    }

    const strategyName = options?.strategy ?? contextManager.getStrategyName()

    // 进入 streaming 状态，显示 compact 进度
    setIsStreaming(true)
    setStreamingMessage(`Compacting ${history.length} messages with strategy: ${strategyName}...`)
    eventBus.emit({ type: 'compact_status', status: 'start', strategy: strategyName, message: `Compacting ${history.length} messages...` })

    try {
      const result = await contextManager.compact(history, provider, {
        model: currentModel,
        ...(options?.strategy !== undefined ? { strategy: options.strategy } : {}),
        ...(options?.focus !== undefined ? { focus: options.focus } : {}),
      })

      // 退出 streaming
      setStreamingMessage(null)
      setIsStreaming(false)

      // 同步 ContextManager + UI messages
      contextManager.replaceHistory(result.history)
      const compactedMsgs: ChatMessage[] = result.history.map(m => ({
        id: randomUUID(),
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }))
      setMessages(compactedMsgs)

      // 记录 compact 事件到 JSONL
      const sid = sessionLogger.sessionId
      if (sid) {
        const compactEventId = generateEventId()
        sessionStore.append(sid, {
          sessionId: sid,
          type: 'compact',
          timestamp: new Date().toISOString(),
          uuid: compactEventId,
          parentUuid: sessionLogger.lastEventUuid,
          cwd: process.cwd(),
          compactSummary: result.summary,
          compactedMessageCount: result.compactedMessageCount,
          tokensBefore: result.tokensBefore,
          compactStrategy: strategyName,
        })
        sessionLogger.bind(sid, compactEventId)
      }

      const doneMsg = `Context compacted (${result.compactedMessageCount} messages → ${result.history.length}). Strategy: ${strategyName}`
      appendSystemMessage(doneMsg)
      eventBus.emit({ type: 'compact_status', status: 'done', strategy: strategyName, message: doneMsg })
    } catch (err) {
      setStreamingMessage(null)
      setIsStreaming(false)
      const errMsg = `Compact failed: ${err instanceof Error ? err.message : String(err)}`
      appendSystemMessage(errMsg)
      eventBus.emit({ type: 'compact_status', status: 'error', message: errMsg })
    }
  }, [isStreaming, messages, currentProvider, currentModel, appendSystemMessage])

  // ── Web 端输入回流：监听 EventBus，将 Web 侧事件桥接到 CLI hook ──

  /** Web 端聊天输入 → 触发 submit（过滤 source=web，避免 CLI submit 循环） */
  useEffect(() => {
    const off = eventBus.onType('user_input', (event) => {
      if (event.source === 'web' && event.text !== '__abort__') {
        submit(event.text, 'web')
      }
    })
    return off
  }, [submit])

  /** Web 端权限响应 → 触发 resolvePermission */
  useEffect(() => {
    const off = eventBus.onType('permission_response', (event) => {
      if (event.source === 'web' && pendingPermission) {
        resolvePermission(event.allow, event.always ?? false)
      }
    })
    return off
  }, [pendingPermission, resolvePermission])

  /** Web 端中止请求：发送特殊消息 __abort__ → 触发 abort */
  useEffect(() => {
    const off = eventBus.onType('user_input', (event) => {
      if (event.source === 'web' && event.text === '__abort__') {
        abort()
      }
    })
    return off
  }, [abort])

  /** Web 端问卷响应 → 触发 resolveQuestion */
  useEffect(() => {
    const off = eventBus.onType('question_response', (event) => {
      if (event.source === 'web' && pendingQuestion) {
        resolveQuestion({
          cancelled: event.cancelled,
          ...(event.answers ? { answers: event.answers } : {}),
        })
      }
    })
    return off
  }, [pendingQuestion, resolveQuestion])

  /** Web 端配置变更 → 刷新当前 provider/model（全局配置，影响所有 CLI 实例） */
  useEffect(() => {
    const off = eventBus.onType('config_changed', (event) => {
      if (event.provider) setCurrentProvider(event.provider)
      if (event.model) setCurrentModel(event.model)
      appendSystemMessage(`配置已更新: ${event.provider} / ${event.model}`)
    })
    return off
  }, [appendSystemMessage])

  return {
    messages,
    streamingMessage,
    toolEvents,
    subAgentEvents,
    isStreaming,
    error,
    pendingPermission,
    pendingQuestion,
    allowedTools,
    currentProvider,
    currentModel,
    todos,
    contextState,
    submit,
    abort,
    interruptAndSubmit,
    resolvePermission,
    resolveQuestion,
    clearMessages,
    appendSystemMessage,
    switchModel,
    getMcpInfo,
    loadSession,
    forkFromEvent,
    compactMessages,
    accumulatedMs,
    sessionStartTime,
  }
}

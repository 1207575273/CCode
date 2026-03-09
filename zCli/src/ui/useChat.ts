// src/ui/useChat.ts

/**
 * useChat — 核心业务 hook，管理对话状态与 AgentLoop 生命周期。
 *
 * 职责：
 * - 维护消息列表（ChatMessage[]）、流式内容、工具事件、错误信息
 * - 管理当前 provider/model（session 级，不持久化到 config）
 * - 驱动 AgentLoop：发起请求、处理事件流、暂停等待权限确认
 * - 提供 clearMessages / appendSystemMessage / switchModel 供指令系统调用
 */

import { useState, useCallback, useRef } from 'react'
import { randomUUID } from 'node:crypto'
import { configManager } from '@config/config-manager.js'
import { createProvider } from '@providers/registry.js'
import { AgentLoop } from '@core/agent-loop.js'
import { ToolRegistry } from '@tools/registry.js'
import { ReadFileTool } from '@tools/read-file.js'
import { WriteFileTool } from '@tools/write-file.js'
import { EditFileTool } from '@tools/edit-file.js'
import { GlobTool } from '@tools/glob.js'
import { GrepTool } from '@tools/grep.js'
import { BashTool } from '@tools/bash.js'
import type { ChatMessage } from './ChatView.js'
import type { Message } from '@core/types.js'
import type { ToolEvent } from './ToolStatusLine.js'
import { loadMcpConfig } from '@config/mcp-config.js'
import { McpManager } from '@mcp/mcp-manager.js'

/** 待用户确认的权限请求，暂停 AgentLoop 直到 resolve 被调用 */
interface PendingPermission {
  toolName: string
  args: Record<string, unknown>
  /** 调用 resolve(true) 允许，resolve(false) 拒绝 */
  resolve: (allow: boolean) => void
}

/** useChat 的完整返回接口 */
export interface UseChatReturn {
  messages: ChatMessage[]
  /** null = 空闲；'' = 等待首 token；非空 = 流式内容累积中 */
  streamingMessage: string | null
  toolEvents: ToolEvent[]
  isStreaming: boolean
  error: string | null
  pendingPermission: PendingPermission | null
  /** session 级工具白名单（选择"always"后写入） */
  allowedTools: Set<string>
  currentProvider: string
  currentModel: string
  /** 发送用户消息，启动 AgentLoop */
  submit: (text: string) => void
  /** 中止当前流式请求 */
  abort: () => void
  /**
   * 解决权限确认。
   * @param allow  是否允许工具执行
   * @param always 是否将工具加入 session 白名单
   */
  resolvePermission: (allow: boolean, always?: boolean) => void
  /** 清空所有消息（/clear 指令调用） */
  clearMessages: () => void
  /** 追加 system 角色消息，仅用于 UI 展示，不发送给 LLM */
  appendSystemMessage: (text: string) => void
  /** 切换 provider 和 model（session 级，不写回 config.json） */
  switchModel: (provider: string, model: string) => void
  /** 获取 MCP Server 状态信息（用于 /mcp 指令） */
  getMcpInfo: () => string
}

let mcpManager: McpManager | null = null
let mcpInitialized = false

async function ensureMcpConnected(registry: ToolRegistry): Promise<void> {
  if (mcpInitialized) {
    // Already initialized — just register existing tools
    if (mcpManager != null) {
      for (const tool of mcpManager.getTools()) {
        registry.register(tool)
      }
    }
    return
  }
  mcpInitialized = true

  const config = loadMcpConfig()
  if (Object.keys(config.mcpServers).length === 0) return

  mcpManager = new McpManager(config)
  await mcpManager.connectAll()
  for (const tool of mcpManager.getTools()) {
    registry.register(tool)
  }
}

/** 构建包含全部内置工具的 ToolRegistry */
function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry()
  reg.register(new ReadFileTool())
  reg.register(new WriteFileTool())
  reg.register(new EditFileTool())
  reg.register(new GlobTool())
  reg.register(new GrepTool())
  reg.register(new BashTool())
  return reg
}

/**
 * 核心对话 hook。
 * 所有 UI 组件通过此 hook 访问对话状态，不直接调用 AgentLoop 或 Provider。
 */
export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set())
  const [currentProvider, setCurrentProvider] = useState<string>(() => configManager.load().defaultProvider ?? '')
  const [currentModel, setCurrentModel] = useState<string>(() => configManager.load().defaultModel ?? '')

  // useRef 双轨：allowedToolsRef 供 async 回调读取最新值（避免闭包捕获陈旧 state）；
  // allowedTools state 驱动 UI 重渲染
  const allowedToolsRef = useRef<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

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
   * 发送用户消息并启动 AgentLoop。
   * system 消息在构建 history 前被过滤，不发送给 LLM。
   */
  const submit = useCallback((text: string) => {
    if (isStreaming) return

    const config = configManager.load()
    // 使用 state 中的 provider/model（可能已通过 /model 切换，与 config 文件不同）
    const provider = createProvider(currentProvider, config)
    const registry = buildRegistry()

    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', content: text }
    // 过滤 system 消息，不发送给 LLM（system 消息仅用于 UI 展示）
    const llmMessages = [...messages, userMsg].filter(m => m.role !== 'system')
    // 类型谓词收窄：确保 history 只含 LLM 接受的 user/assistant 角色
    const history: Message[] = llmMessages
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
      )
      .map(m => ({ role: m.role, content: m.content }))

    setMessages(prev => [...prev, userMsg])
    setStreamingMessage('')
    setToolEvents([])
    setIsStreaming(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    const loop = new AgentLoop(provider, registry, {
      model: currentModel,
      signal: controller.signal,
    })

    // toolCallId → eventId 映射，保证多次调用同名工具时状态更新精确匹配
    const pendingToolIds = new Map<string, string>()

    ;(async () => {
      let accumulated = ''
      try {
        await ensureMcpConnected(registry)
        for await (const event of loop.run(history)) {
          if (event.type === 'text') {
            accumulated += event.text
            setStreamingMessage(accumulated)
          } else if (event.type === 'tool_start') {
            const id = randomUUID()
            pendingToolIds.set(event.toolCallId, id)
            setToolEvents(prev => [...prev, { id, toolName: event.toolName, args: event.args, status: 'running' }])
          } else if (event.type === 'tool_done') {
            const matchId = pendingToolIds.get(event.toolCallId)
            if (matchId) pendingToolIds.delete(event.toolCallId)
            setToolEvents(prev => prev.map(e =>
              e.id === matchId
                ? { ...e, status: event.success ? 'done' as const : 'error' as const, durationMs: event.durationMs }
                : e
            ))
          } else if (event.type === 'permission_request') {
            // 白名单工具直接放行，无需弹窗
            if (allowedToolsRef.current.has(event.toolName)) {
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
          const assistantMsg: ChatMessage = { id: randomUUID(), role: 'assistant', content: accumulated }
          setMessages(prev => [...prev, assistantMsg])
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setStreamingMessage(null)
        setIsStreaming(false)
        abortRef.current = null
      }
    })()
  }, [isStreaming, messages, currentProvider, currentModel])

  /** 中止当前 AgentLoop 请求（用户主动取消或超时） */
  const abort = useCallback(() => { abortRef.current?.abort() }, [])

  /** 清空消息列表（/clear 指令） */
  const clearMessages = useCallback((): void => {
    setMessages([])
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

  /** 获取 MCP Server 状态信息 */
  const getMcpInfo = useCallback((): string => {
    if (mcpManager == null || !mcpInitialized) {
      return 'MCP: 未初始化（首次发送消息后连接）'
    }
    const status = mcpManager.getStatus()
    if (status.length === 0) {
      return 'MCP: 无已连接的 Server'
    }
    const lines = ['MCP Servers:']
    for (const s of status) {
      lines.push(`  ● ${s.name} (${s.toolCount} tools)`)
      for (const toolName of s.toolNames) {
        lines.push(`    - ${toolName}`)
      }
    }
    return lines.join('\n')
  }, [])

  return {
    messages,
    streamingMessage,
    toolEvents,
    isStreaming,
    error,
    pendingPermission,
    allowedTools,
    currentProvider,
    currentModel,
    submit,
    abort,
    resolvePermission,
    clearMessages,
    appendSystemMessage,
    switchModel,
    getMcpInfo,
  }
}

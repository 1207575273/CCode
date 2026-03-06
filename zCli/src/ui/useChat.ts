// src/ui/useChat.ts
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

interface PendingPermission {
  toolName: string
  args: Record<string, unknown>
  resolve: (allow: boolean) => void
}

export interface UseChatReturn {
  messages: ChatMessage[]
  streamingMessage: string | null
  toolEvents: ToolEvent[]
  isStreaming: boolean
  error: string | null
  pendingPermission: PendingPermission | null
  allowedTools: Set<string>
  submit: (text: string) => void
  abort: () => void
  resolvePermission: (allow: boolean, always?: boolean) => void
}

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

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  const resolvePermission = useCallback((allow: boolean, always = false) => {
    setPendingPermission(prev => {
      if (!prev) return null
      if (allow && always) {
        setAllowedTools(existing => new Set([...existing, prev.toolName]))
      }
      prev.resolve(allow)
      return null
    })
  }, [])

  const submit = useCallback((text: string) => {
    if (isStreaming) return

    const config = configManager.load()
    const provider = createProvider(config.defaultProvider, config)
    const registry = buildRegistry()

    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', content: text }
    const history: Message[] = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))

    setMessages(prev => [...prev, userMsg])
    setStreamingMessage('')
    setToolEvents([])
    setIsStreaming(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    const loop = new AgentLoop(provider, registry, {
      model: config.defaultModel,
      signal: controller.signal,
    })

    // 捕获当前 allowedTools（闭包）
    const currentAllowed = allowedTools

    ;(async () => {
      let accumulated = ''
      try {
        for await (const event of loop.run(history)) {
          if (event.type === 'text') {
            accumulated += event.text
            setStreamingMessage(accumulated)
          } else if (event.type === 'tool_start') {
            const id = randomUUID()
            setToolEvents(prev => [...prev, { id, toolName: event.toolName, args: event.args, status: 'running' }])
          } else if (event.type === 'tool_done') {
            setToolEvents(prev => prev.map(e =>
              e.toolName === event.toolName && e.status === 'running'
                ? { ...e, status: event.success ? 'done' as const : 'error' as const, durationMs: event.durationMs }
                : e
            ))
          } else if (event.type === 'permission_request') {
            if (currentAllowed.has(event.toolName)) {
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
  }, [isStreaming, messages, allowedTools])

  const abort = useCallback(() => { abortRef.current?.abort() }, [])

  return { messages, streamingMessage, toolEvents, isStreaming, error, pendingPermission, allowedTools, submit, abort, resolvePermission }
}

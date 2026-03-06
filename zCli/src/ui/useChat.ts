// src/ui/useChat.ts
import { useState, useCallback, useRef } from 'react'
import { randomUUID } from 'node:crypto'
import { configManager } from '@config/config-manager.js'
import { createProvider } from '@providers/registry.js'
import type { ChatMessage } from './ChatView.js'
import type { Message } from '@core/types.js'

interface UseChatReturn {
  messages: ChatMessage[]
  streamingMessage: string | null
  isStreaming: boolean
  error: string | null
  submit: (text: string) => void
  abort: () => void
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const submit = useCallback((text: string) => {
    if (isStreaming) return

    const config = configManager.load()
    const provider = createProvider(config.defaultProvider, config)

    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', content: text }

    setMessages(prev => [...prev, userMsg])
    setStreamingMessage('')   // 空气泡 + spinner
    setIsStreaming(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    // 构建发送给 LLM 的消息历史（含本次用户消息）
    const history: Message[] = [...messages, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }))

    ;(async () => {
      let accumulated = ''
      try {
        const stream = provider.chat({
          model: config.defaultModel,
          messages: history,
          signal: controller.signal,
        })

        for await (const chunk of stream) {
          if (chunk.type === 'text' && chunk.text) {
            accumulated += chunk.text
            setStreamingMessage(accumulated)
          } else if (chunk.type === 'done') {
            break
          } else if (chunk.type === 'error') {
            throw new Error(chunk.error ?? '未知错误')
          }
        }

        const assistantMsg: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: accumulated,
        }
        setMessages(prev => [...prev, assistantMsg])
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
  }, [isStreaming, messages])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { messages, streamingMessage, isStreaming, error, submit, abort }
}

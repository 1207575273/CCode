// src/providers/anthropic.ts

/**
 * AnthropicProvider — 基于 @anthropic-ai/sdk 的原生 Anthropic 协议实现。
 *
 * 直接使用官方 SDK，不经过 LangChain 中间层，确保：
 * - baseURL / authToken 等参数完整透传
 * - 流式事件精确映射（text delta、tool_use、usage）
 * - 第三方兼容 API（MiniMax 等）认证可控
 */

import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, ChatRequest, ProviderProtocol } from './provider.js'
import type { Message, MessageContent, StreamChunk, ToolCallContent, ImageContent } from '@core/types.js'
import { readImageBase64 } from '@core/image-store.js'
import type { ProviderConfig } from '@config/config-manager.js'
import { findOrphanToolCalls } from '@core/message-utils.js'
import { dbg } from '../debug.js'
import { withRetry, friendlyErrorMessage } from './retry.js'

/** 将内部 Message 转为 Anthropic SDK 的消息格式 */
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  // Debug 模式下检查 tool_call/tool_result 成对关系
  if (process.env.CCODE_DEBUG) {
    assertToolCallResultPairing(messages)
  }

  const raw: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue // system 走独立参数

    const content = msg.content

    if (typeof content === 'string') {
      raw.push({ role: msg.role as 'user' | 'assistant', content })
      continue
    }

    // 数组内容：逐块转换
    const blocks = Array.isArray(content) ? content : [content]
    const parts: Anthropic.ContentBlockParam[] = []

    for (const block of blocks) {
      switch ((block as MessageContent).type) {
        case 'text':
          parts.push({ type: 'text', text: (block as MessageContent & { type: 'text' }).text })
          break
        case 'tool_call': {
          const tc = block as ToolCallContent
          parts.push({
            type: 'tool_use',
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.args,
          })
          break
        }
        case 'tool_result': {
          const tr = block as MessageContent & { type: 'tool_result' }
          parts.push({
            type: 'tool_result',
            tool_use_id: tr.toolCallId,
            content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
            ...(tr.isError ? { is_error: true } : {}),
          })
          break
        }
        case 'image': {
          // 延迟加载：只在真正发送给 LLM 时才读取 base64
          const img = block as ImageContent
          const data = readImageBase64(img.imageId)
          if (data) {
            parts.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: data.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: data.base64,
              },
            })
          }
          // 图片文件不存在时静默跳过（已过期或被 GC 清理）
          break
        }
      }
    }

    if (parts.length > 0) {
      raw.push({ role: msg.role as 'user' | 'assistant', content: parts })
    }
  }

  // 合并连续相同 role 的消息（Anthropic 要求 user/assistant 严格交替）
  return mergeConsecutiveRoles(raw)
}

/**
 * 合并连续相同 role 的消息，确保 Anthropic API 不报 400。
 * 改造后 history 格式标准（assistant → user 交替），此函数作为防御性保障。
 */
function mergeConsecutiveRoles(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages
  const merged: Anthropic.MessageParam[] = [messages[0]!]
  for (let i = 1; i < messages.length; i++) {
    const cur = messages[i]!
    const last = merged[merged.length - 1]!
    if (last.role === cur.role) {
      // 合并 content
      const lastParts = typeof last.content === 'string'
        ? [{ type: 'text' as const, text: last.content }]
        : last.content
      const curParts = typeof cur.content === 'string'
        ? [{ type: 'text' as const, text: cur.content }]
        : cur.content
      merged[merged.length - 1] = { role: last.role, content: [...lastParts, ...curParts] }
    } else {
      merged.push(cur)
    }
  }
  return merged
}

export class AnthropicProvider implements LLMProvider {
  readonly name: string
  readonly protocol: ProviderProtocol = 'native-anthropic'

  readonly #config: ProviderConfig
  readonly #client: Anthropic

  constructor(providerName: string, config: ProviderConfig) {
    this.name = providerName
    this.#config = config

    // 构建 SDK 客户端：
    // - 官方 Anthropic：apiKey → x-api-key 头
    // - 第三方兼容（MiniMax 等）：baseURL + defaultHeaders 显式设置 Authorization: Bearer
    if (config.baseURL) {
      this.#client = new Anthropic({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        defaultHeaders: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
      })
    } else {
      this.#client = new Anthropic({
        apiKey: config.apiKey,
      })
    }
  }

  isModelSupported(model: string): boolean {
    return this.#config.models.includes(model)
  }

  async *chat(request: ChatRequest): AsyncIterable<StreamChunk> {
    // 提取 system prompt
    const systemPrompt = request.systemPrompt
    const anthropicMessages = toAnthropicMessages(request.messages)

    // 构建工具定义
    const tools: Anthropic.Tool[] | undefined = request.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }))

    dbg(`[DEBUG][anthropic] chat request:\n`)
    dbg(`  model: ${request.model}\n`)
    dbg(`  messages: ${JSON.stringify(anthropicMessages, null, 2)}\n`)

    // withRetry 包装：在连接建立阶段自动重试 429/5xx/网络错误
    const createStream = () => this.#chatOnce(request.model, anthropicMessages, tools, systemPrompt, request)
    try {
      yield* withRetry(createStream, this.name)
    } catch (err) {
      dbg(`[DEBUG][anthropic] error after retries: ${err}\n`)
      yield { type: 'error', error: friendlyErrorMessage(err instanceof Error ? err : new Error(String(err))) }
    }
  }

  /** 单次 LLM 调用（不含重试），供 withRetry 包装 */
  async *#chatOnce(
    model: string,
    anthropicMessages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[] | undefined,
    systemPrompt: string | undefined,
    request: ChatRequest,
  ): AsyncIterable<StreamChunk> {
    // Prompt caching：system prompt 与 tools 定义在会话内稳定不变，打上 cache_control 断点让 Anthropic
    // 缓存这段前缀（默认 TTL 5min），长会话多轮请求里这部分 input token 基本走 cache_read 计费。
    // - 开关：CCODE_DISABLE_PROMPT_CACHE=1 回退到原字符串/普通 tools 形式，兼容不支持 cache_control 的
    //   第三方 Anthropic 协议代理（MiniMax / OpenRouter 等 baseURL 场景）
    // - 长度保护：Anthropic 缓存最小命中门槛约 1024 tokens，system < 4000 字符（约 1000 tokens）就不加，
    //   避免请求体变复杂却拿不到缓存
    // - tools cache_control 只标最后一个：缓存断点向前累积，一个断点即可覆盖整个 tools 数组
    const cacheEnabled = process.env.CCODE_DISABLE_PROMPT_CACHE !== '1'
    const MIN_CACHE_CHARS = 4000
    const cacheSystem = cacheEnabled
      && typeof systemPrompt === 'string'
      && systemPrompt.length >= MIN_CACHE_CHARS

    const systemParam: string | Anthropic.TextBlockParam[] | undefined = cacheSystem
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt

    let toolsParam: Anthropic.Tool[] | undefined = tools
    if (cacheEnabled && tools && tools.length > 0) {
      const lastIdx = tools.length - 1
      toolsParam = tools.map((t, i) =>
        i === lastIdx ? { ...t, cache_control: { type: 'ephemeral' as const } } : t,
      )
    }

    const stream = this.#client.messages.stream({
      model,
      max_tokens: request.maxTokens ?? 8192,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(systemParam !== undefined ? { system: systemParam } : {}),
      messages: anthropicMessages,
      ...(toolsParam && toolsParam.length > 0 ? { tools: toolsParam } : {}),
    }, {
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    dbg(`[DEBUG][anthropic] stream opened, receiving events...\n`)

    for await (const event of stream) {
      dbg(`[DEBUG][anthropic] event: ${JSON.stringify(event)}\n`)

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text }
        } else if ((event.delta as { type: string; thinking?: string }).type === 'thinking_delta') {
          const thinkingDelta = (event.delta as { type: string; thinking?: string }).thinking ?? ''
          if (thinkingDelta) yield { type: 'thinking', thinking: thinkingDelta }
        }
      }
    }

    const finalMsg = await stream.finalMessage()

    if (finalMsg.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: finalMsg.usage.input_tokens,
          outputTokens: finalMsg.usage.output_tokens,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cacheReadTokens: (finalMsg.usage as any)['cache_read_input_tokens'] ?? 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cacheWriteTokens: (finalMsg.usage as any)['cache_creation_input_tokens'] ?? 0,
        },
      }
    }

    for (const block of finalMsg.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_call',
          toolCall: {
            type: 'tool_call',
            toolCallId: block.id,
            toolName: block.name,
            args: block.input as Record<string, unknown>,
          },
        }
      }
    }

    yield { type: 'done', stopReason: finalMsg.stop_reason ?? 'end_turn' }
  }

  async countTokens(messages: Message[]): Promise<number> {
    // 简单估算：按字符数 / 4 近似 token 数
    const text = messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(' ')
    return Math.ceil(text.length / 4)
  }

  createSession(): LLMProvider {
    return this  // Anthropic SDK 无状态，安全共享
  }

  dispose(): void {
    // Anthropic SDK 无需清理
  }
}

/** Debug 断言：检查 tool_call/tool_result 成对关系（仅 CCODE_DEBUG 时执行） */
function assertToolCallResultPairing(messages: Message[]): void {
  const orphans = findOrphanToolCalls(messages)
  if (orphans.length > 0) {
    const desc = orphans.map(o => `${o.toolName}(${o.toolCallId})`).join(', ')
    console.warn(`[MSG-INTEGRITY][anthropic] ${orphans.length} tool_call(s) without matching tool_result: ${desc}`)
  }
}

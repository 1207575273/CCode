// src/core/agent-loop.ts

/**
 * AgentLoop — LLM ↔ 工具的多轮执行引擎。
 *
 * 单次 run() 调用对应一次用户提问的完整处理过程：
 *   1. 调用 LLM → 收集文本和工具调用
 *   2. 如有工具调用 → 逐个执行（含权限检查） → 将结果追加到历史
 *   3. 回到步骤 1 进入下一轮，直到 LLM 不再调用工具
 *
 * 所有中间状态通过 AsyncGenerator<AgentEvent> yield 出去，
 * 调用方（useChat）和观察者（SessionLogger）各取所需。
 */

import type { LLMProvider } from '@providers/provider.js'
import type { ToolRegistry } from '@tools/registry.js'
import type { Message, ToolCallContent, StreamChunk } from './types.js'

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/**
 * AgentEvent — run() 的 yield 类型。
 *
 * 业务事件（UI 消费）：
 *   text / tool_start / tool_done / permission_request / error / done
 *
 * 观测事件（SessionLogger 消费，写入 JSONL）：
 *   llm_start / llm_usage / llm_error / tool_fallback / permission_grant
 */
export type AgentEvent =
  // 业务事件
  | { type: 'text';               text: string }
  | { type: 'tool_start';         toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done';          toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown>; resolve: (allow: boolean) => void }
  | { type: 'error';              error: string }
  | { type: 'done' }
  // 观测事件
  | { type: 'llm_start';          provider: string; model: string; messageCount: number }
  | { type: 'llm_usage';          inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; stopReason: string }
  | { type: 'llm_error';          error: string; partialOutputTokens?: number }
  | { type: 'tool_fallback';      toolName: string; fromLevel: string; toLevel: string; reason: string }
  | { type: 'permission_grant';   toolName: string; always: boolean }

export interface AgentConfig {
  model: string
  /** provider 名称，记录到 llm_start 事件 */
  provider: string
  signal?: AbortSignal
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 最大自动执行轮次，防止死循环 */
const MAX_TURNS = 20

/** resultSummary 最大长度 */
const RESULT_SUMMARY_MAX_LENGTH = 200

// ═══════════════════════════════════════════════
// AgentLoop 类
// ═══════════════════════════════════════════════

export class AgentLoop {
  readonly #provider: LLMProvider
  readonly #registry: ToolRegistry
  readonly #config: AgentConfig

  constructor(
    provider: LLMProvider,
    registry: ToolRegistry,
    config: AgentConfig,
  ) {
    this.#provider = provider
    this.#registry = registry
    this.#config = config
  }

  /**
   * 主循环：LLM 调用 → [工具执行 → LLM 调用]* → 文本回复
   */
  async *run(messages: Message[]): AsyncIterable<AgentEvent> {
    const history: Message[] = [...messages]

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const llmResult = yield* this.#callLLM(history)
      if (llmResult.aborted) return

      if (llmResult.toolCalls.length === 0) {
        yield { type: 'done' }
        return
      }

      for (const tc of llmResult.toolCalls) {
        yield* this.#executeOneTool(tc, history)
      }
    }

    yield { type: 'error', error: `超过最大轮次限制 (${MAX_TURNS})` }
  }

  // ─────────────────────────────────────────────
  // LLM 调用
  // ─────────────────────────────────────────────

  /**
   * 调用 LLM 并收集流式输出。
   *
   * yield: llm_start → text* → llm_usage | llm_error
   * return: 收集到的工具调用列表 + 是否因错误中止
   */
  async *#callLLM(
    history: Message[],
  ): AsyncGenerator<AgentEvent, { toolCalls: ToolCallContent[]; aborted: boolean }> {
    const chatRequest = {
      model: this.#config.model,
      messages: history,
      tools: this.#registry.toToolDefinitions(),
      ...(this.#config.signal !== undefined ? { signal: this.#config.signal } : {}),
    }

    yield { type: 'llm_start', provider: this.#config.provider, model: this.#config.model, messageCount: history.length }

    const pendingToolCalls: ToolCallContent[] = []
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0

    try {
      for await (const chunk of this.#provider.chat(chatRequest)) {
        const mapped = this.#mapChunk(chunk, pendingToolCalls)
        if (mapped) {
          if (mapped.type === 'error') {
            yield makeLlmError(chunk.error ?? 'unknown error', outputTokens)
            yield mapped
            return { toolCalls: [], aborted: true }
          }
          yield mapped
        }
        if (chunk.type === 'usage' && chunk.usage) {
          inputTokens = chunk.usage.inputTokens
          outputTokens = chunk.usage.outputTokens
          cacheReadTokens = chunk.usage.cacheReadTokens
          cacheWriteTokens = chunk.usage.cacheWriteTokens
        }
      }

      yield { type: 'llm_usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, stopReason: 'end_turn' }
      return { toolCalls: pendingToolCalls, aborted: false }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        yield { type: 'llm_usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, stopReason: 'abort' }
      } else {
        yield makeLlmError(err instanceof Error ? err.message : String(err), outputTokens)
      }
      throw err
    }
  }

  /** StreamChunk → AgentEvent 映射，null 表示不产生事件 */
  #mapChunk(chunk: StreamChunk, pendingToolCalls: ToolCallContent[]): AgentEvent | null {
    switch (chunk.type) {
      case 'text':   return chunk.text ? { type: 'text', text: chunk.text } : null
      case 'tool_call': { if (chunk.toolCall) pendingToolCalls.push(chunk.toolCall); return null }
      case 'error':  return { type: 'error', error: chunk.error ?? 'unknown error' }
      default:       return null // usage / done 不产生业务事件
    }
  }

  // ─────────────────────────────────────────────
  // 工具执行
  // ─────────────────────────────────────────────

  /**
   * 执行单个工具调用。
   *
   * yield: tool_start → [permission_request → permission_grant] → tool_done
   */
  async *#executeOneTool(tc: ToolCallContent, history: Message[]): AsyncGenerator<AgentEvent> {
    yield { type: 'tool_start', toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.args }

    // 权限检查
    const allowed = yield* this.#checkPermission(tc)
    if (!allowed) {
      history.push({ role: 'user', content: `[Tool ${tc.toolName} was rejected by user]` })
      yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs: 0, success: false, resultSummary: 'rejected by user' }
      return
    }

    // 执行
    const start = Date.now()
    const result = await this.#registry.execute(tc.toolName, tc.args, { cwd: process.cwd() })
    const durationMs = Date.now() - start

    history.push({
      role: 'user',
      content: result.success
        ? `[Tool ${tc.toolName} result]: ${result.output}`
        : `[Tool ${tc.toolName} error]: ${result.error ?? 'error'}`,
    })

    const resultSummary = result.success
      ? truncate(result.output, RESULT_SUMMARY_MAX_LENGTH)
      : (result.error ?? 'error')

    yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs, success: result.success, resultSummary }
  }

  /** 安全工具直接放行；危险工具 yield permission_request 暂停等待用户确认 */
  async *#checkPermission(tc: ToolCallContent): AsyncGenerator<AgentEvent, boolean> {
    if (!this.#registry.isDangerous(tc.toolName)) return true

    let resolvePermission!: (v: boolean) => void
    const promise = new Promise<boolean>(r => { resolvePermission = r })
    yield { type: 'permission_request', toolName: tc.toolName, args: tc.args, resolve: resolvePermission }
    const allowed = await promise

    if (allowed) {
      yield { type: 'permission_grant', toolName: tc.toolName, always: false }
    }
    return allowed
  }
}

// ═══════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
}

/** 构造 llm_error 事件（兼容 exactOptionalPropertyTypes） */
function makeLlmError(error: string, partialTokens: number): AgentEvent {
  return partialTokens > 0
    ? { type: 'llm_error', error, partialOutputTokens: partialTokens }
    : { type: 'llm_error', error }
}

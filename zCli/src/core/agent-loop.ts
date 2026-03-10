// src/core/agent-loop.ts
import type { LLMProvider } from '@providers/provider.js'
import type { ToolRegistry } from '@tools/registry.js'
import type { Message, ToolCallContent } from './types.js'

export type AgentEvent =
  // 已有
  | { type: 'text';               text: string }
  | { type: 'tool_start';         toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done';          toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown>; resolve: (allow: boolean) => void }
  | { type: 'error';              error: string }
  | { type: 'done' }
  // F9 新增：观测事件
  | { type: 'llm_start';          provider: string; model: string; messageCount: number }
  | { type: 'llm_usage';          inputTokens: number; outputTokens: number; stopReason: string }
  | { type: 'llm_error';          error: string; partialOutputTokens?: number }
  | { type: 'tool_fallback';      toolName: string; fromLevel: string; toLevel: string; reason: string }
  | { type: 'permission_grant';   toolName: string; always: boolean }

interface AgentConfig {
  model: string
  provider: string  // provider 名称，用于 llm_start 事件
  signal?: AbortSignal
}

const MAX_TURNS = 20

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

  async *run(messages: Message[]): AsyncIterable<AgentEvent> {
    const history: Message[] = [...messages]

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const toolDefs = this.#registry.toToolDefinitions()
      const pendingToolCalls: ToolCallContent[] = []

      // 调用 LLM，收集本轮流式输出
      const chatRequest = {
        model: this.#config.model,
        messages: history,
        tools: toolDefs,
        ...(this.#config.signal !== undefined ? { signal: this.#config.signal } : {}),
      }

      // F9: LLM 调用前 yield 观测事件
      yield { type: 'llm_start', provider: this.#config.provider, model: this.#config.model, messageCount: history.length }
      let llmInputTokens = 0
      let llmOutputTokens = 0

      try {
        for await (const chunk of this.#provider.chat(chatRequest)) {
          if (chunk.type === 'text' && chunk.text) {
            yield { type: 'text', text: chunk.text }
          } else if (chunk.type === 'tool_call' && chunk.toolCall) {
            pendingToolCalls.push(chunk.toolCall)
          } else if (chunk.type === 'usage' && chunk.usage) {
            llmInputTokens = chunk.usage.inputTokens
            llmOutputTokens = chunk.usage.outputTokens
          } else if (chunk.type === 'error') {
            const llmErr: AgentEvent = llmOutputTokens > 0
              ? { type: 'llm_error', error: chunk.error ?? 'unknown error', partialOutputTokens: llmOutputTokens }
              : { type: 'llm_error', error: chunk.error ?? 'unknown error' }
            yield llmErr
            yield { type: 'error', error: chunk.error ?? 'unknown error' }
            return
          }
          // 'done' chunk 不需要 yield，由循环逻辑控制
        }
        // F9: LLM 调用正常结束
        yield { type: 'llm_usage', inputTokens: llmInputTokens, outputTokens: llmOutputTokens, stopReason: 'end_turn' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if ((err as Error).name === 'AbortError') {
          yield { type: 'llm_usage', inputTokens: llmInputTokens, outputTokens: llmOutputTokens, stopReason: 'abort' }
        } else {
          const catchErr: AgentEvent = llmOutputTokens > 0
            ? { type: 'llm_error', error: msg, partialOutputTokens: llmOutputTokens }
            : { type: 'llm_error', error: msg }
          yield catchErr
        }
        throw err
      }

      // 无工具调用 → 本轮结束，整个 AgentLoop 结束
      if (pendingToolCalls.length === 0) {
        yield { type: 'done' }
        return
      }

      // 执行每个工具调用
      for (const tc of pendingToolCalls) {
        yield { type: 'tool_start', toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.args }

        let allowed = true

        if (this.#registry.isDangerous(tc.toolName)) {
          // 用 Promise 暂停 async generator，等待调用方调用 resolve
          let resolvePermission!: (v: boolean) => void
          const permissionPromise = new Promise<boolean>(r => { resolvePermission = r })
          yield { type: 'permission_request', toolName: tc.toolName, args: tc.args, resolve: resolvePermission }
          allowed = await permissionPromise
        }

        if (!allowed) {
          // 将拒绝结果追加到历史
          history.push({
            role: 'user',
            content: `[Tool ${tc.toolName} was rejected by user]`,
          })
          yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs: 0, success: false, resultSummary: 'rejected by user' }
          continue
        }

        // F9: 权限授予事件
        if (this.#registry.isDangerous(tc.toolName)) {
          yield { type: 'permission_grant', toolName: tc.toolName, always: false }
        }

        const start = Date.now()
        const result = await this.#registry.execute(tc.toolName, tc.args, { cwd: process.cwd() })
        const durationMs = Date.now() - start

        // 将工具结果追加到历史，供下一轮 LLM 参考
        const resultText = result.success
          ? `[Tool ${tc.toolName} result]: ${result.output}`
          : `[Tool ${tc.toolName} error]: ${result.error ?? 'error'}`
        history.push({ role: 'user', content: resultText })

        // F9: resultSummary 截断到 200 字符
        const resultSummary = result.success
          ? (result.output.length > 200 ? result.output.slice(0, 200) + '...' : result.output)
          : (result.error ?? 'error')

        yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs, success: result.success, resultSummary }
      }
    }

    yield { type: 'error', error: `超过最大轮次限制 (${MAX_TURNS})` }
  }
}

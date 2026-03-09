// src/core/agent-loop.ts
import type { LLMProvider } from '@providers/provider.js'
import type { ToolRegistry } from '@tools/registry.js'
import type { Message, ToolCallContent } from './types.js'

export type AgentEvent =
  | { type: 'text';               text: string }
  | { type: 'tool_start';         toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done';          toolName: string; toolCallId: string; durationMs: number; success: boolean }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown>; resolve: (allow: boolean) => void }
  | { type: 'error';              error: string }
  | { type: 'done' }

interface AgentConfig {
  model: string
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
      for await (const chunk of this.#provider.chat(chatRequest)) {
        if (chunk.type === 'text' && chunk.text) {
          yield { type: 'text', text: chunk.text }
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall)
        } else if (chunk.type === 'error') {
          yield { type: 'error', error: chunk.error ?? 'unknown error' }
          return
        }
        // 'done' / 'usage' chunk 不需要 yield，由循环逻辑控制
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
          yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs: 0, success: false }
          continue
        }

        const start = Date.now()
        const result = await this.#registry.execute(tc.toolName, tc.args, { cwd: process.cwd() })
        const durationMs = Date.now() - start

        // 将工具结果追加到历史，供下一轮 LLM 参考
        history.push({
          role: 'user',
          content: result.success
            ? `[Tool ${tc.toolName} result]: ${result.output}`
            : `[Tool ${tc.toolName} error]: ${result.error ?? 'error'}`,
        })

        yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs, success: result.success }
      }
    }

    yield { type: 'error', error: `超过最大轮次限制 (${MAX_TURNS})` }
  }
}

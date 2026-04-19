// src/core/llm-call-session.ts

/**
 * LLMCallSession — 单次 LLM 调用的完整会话。
 *
 * 背景(docs/plans/20260420012229_agent-loop重构评审.md P0-03 第 2/3/4/5 项职责外迁):
 * 原 AgentLoop.#callLLM 130+ 行内联了 5 件事(流式消费、chunk→事件映射、性能指标、
 * Prompt Cache 指纹、contextTracker 更新),AgentLoop 的 run() 三步清单被污染。
 * 本模块把这 5 件事打包为 invoke(),AgentLoop.run() 只负责驱动循环。
 *
 * invoke 返回值为 LLMCallResult({ toolCalls, text, aborted }),让调用方决定后续分支。
 *
 * Prompt Cache fingerprint 状态为 per-session(跨 invoke 持久),每个 AgentLoop 实例
 * 持有独立的 session(子 Agent 不共享)。
 */

import type {LLMProvider} from '@providers/provider.js'
import type {ToolRegistry} from '@tools/core/registry.js'
import type {Message, StreamChunk, ToolCallContent} from './types.js'
import type {AgentEvent} from './agent-events.js'
import {contextTracker} from './context-tracker.js'
import {dbg} from '../debug.js'

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

export interface LLMCallResult {
    toolCalls: ToolCallContent[]
    text: string
    aborted: boolean
}

export interface LLMCallSessionConfig {
    model: string
    /** provider 名称(记录到 llm_start 事件) */
    providerName: string
    signal?: AbortSignal | undefined
    systemPrompt?: string | undefined
    /** SubAgent 有独立 context,不应覆盖主 Agent 的全局 contextTracker */
    isSidechain?: boolean | undefined
}

// ═══════════════════════════════════════════════
// LLMCallSession
// ═══════════════════════════════════════════════

export class LLMCallSession {
    readonly #provider: LLMProvider
    readonly #registry: ToolRegistry
    readonly #config: LLMCallSessionConfig
    /** 跨 invoke 的状态:Prompt Cache 指纹 + 调用计数 */
    #llmCallIndex = 0
    #lastCacheFingerprint: string | null = null

    constructor(provider: LLMProvider, registry: ToolRegistry, config: LLMCallSessionConfig) {
        this.#provider = provider
        this.#registry = registry
        this.#config = config
    }

    /**
     * 执行一次 LLM 调用,消费流式响应。
     *
     * yield: llm_start → text* / thinking* / tool_call* / llm_done | llm_error
     * return: { toolCalls, text, aborted } — aborted=true 表示 error chunk 终止(非 throw)
     */
    async* invoke(messages: ReadonlyArray<Message>): AsyncGenerator<AgentEvent, LLMCallResult> {
        const chatRequest = {
            model: this.#config.model,
            messages: [...messages],  // 拷贝一份避免 provider 误改
            tools: this.#registry.toToolDefinitions(),
            ...(this.#config.signal !== undefined ? {signal: this.#config.signal} : {}),
            ...(this.#config.systemPrompt !== undefined ? {systemPrompt: this.#config.systemPrompt} : {}),
        }

        yield {
            type: 'llm_start',
            provider: this.#config.providerName,
            model: this.#config.model,
            messageCount: messages.length,
            ...(this.#config.systemPrompt !== undefined ? {systemPrompt: this.#config.systemPrompt} : {}),
        }

        const pendingToolCalls: ToolCallContent[] = []
        let accumulatedText = ''
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheWriteTokens = 0
        // 从 done chunk 中取 stopReason,经 ProviderWrapper 标准化后直接使用
        let doneStopReason = 'end_turn'

        // 性能层:计时变量
        const requestStart = Date.now()
        let firstContentChunk = false
        let ttftMs = 0

        try {
            for await (const chunk of this.#provider.chat(chatRequest)) {
                // TTFT:首个有内容的 chunk(text/thinking/tool_call)才算
                if (!firstContentChunk && (chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_call')) {
                    ttftMs = Date.now() - requestStart
                    firstContentChunk = true
                }

                const mapped = mapChunkToEvent(chunk, pendingToolCalls)
                if (mapped) {
                    if (mapped.type === 'text' && 'text' in mapped) accumulatedText += mapped.text
                    if (mapped.type === 'error') {
                        const errorMsg = chunk.error ?? 'unknown error'
                        // Provider 将 abort 错误包装为 error chunk(不抛出)→ 重新抛出使 catch 路径生效
                        if (errorMsg.toLowerCase().includes('aborted')) {
                            const abortErr = new Error(errorMsg)
                            abortErr.name = 'AbortError'
                            throw abortErr
                        }
                        yield makeLlmError(errorMsg, outputTokens)
                        yield mapped
                        return {toolCalls: [], text: '', aborted: true}
                    }
                    yield mapped
                }
                if (chunk.type === 'usage' && chunk.usage) {
                    inputTokens = chunk.usage.inputTokens
                    outputTokens = chunk.usage.outputTokens
                    cacheReadTokens = chunk.usage.cacheReadTokens
                    cacheWriteTokens = chunk.usage.cacheWriteTokens
                }
                if (chunk.type === 'done') {
                    doneStopReason = chunk.stopReason ?? 'end_turn'
                }
            }

            // E2E + TPS 计算
            const e2eMs = Date.now() - requestStart
            // 纯工具调用场景:Anthropic 的 tool_call 是流结束后才 yield,
            // ttftMs ≈ e2eMs 使 generationMs ≈ 0。此时退化用 e2eMs 作为分母,
            // 给出"整体吞吐率"而非"纯 generation 阶段吞吐率"。
            const generationMs = e2eMs - ttftMs
            const tpsBase = generationMs > 50 ? generationMs : e2eMs  // 50ms 阈值避免极小值放大噪声
            const tps = tpsBase > 0 && outputTokens > 0
                ? Math.round(outputTokens / (tpsBase / 1000) * 10) / 10
                : 0
            dbg(`[PERF] TTFT=${ttftMs}ms E2E=${e2eMs}ms TPS=${tps} tokens/s (base=${tpsBase}ms)\n`)

            // Prompt Cache 破裂检测:systemPrompt + tools 指纹变化 → 缓存失效
            this.#llmCallIndex++
            const fingerprint = simpleHash(
                (this.#config.systemPrompt ?? '') +
                JSON.stringify(this.#registry.toToolDefinitions().map(t => t.name)),
            )
            if (this.#lastCacheFingerprint !== null && this.#lastCacheFingerprint !== fingerprint) {
                dbg(`[CACHE-BREAK] LLM call #${this.#llmCallIndex}: prompt/tools fingerprint changed (${this.#lastCacheFingerprint} → ${fingerprint})\n`)
            } else if (this.#llmCallIndex > 1 && cacheReadTokens === 0 && inputTokens > 2000) {
                dbg(`[CACHE-MISS] LLM call #${this.#llmCallIndex}: cacheReadTokens=0 with ${inputTokens} input tokens\n`)
            }
            this.#lastCacheFingerprint = fingerprint

            yield {
                type: 'llm_done',
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                stopReason: doneStopReason,
                ttftMs,
                e2eMs,
                tps,
            }
            // 仅主 Agent 更新 — 子 Agent(isSidechain)有独立上下文,不应覆盖主 Agent 的追踪值
            if (inputTokens > 0 && !this.#config.isSidechain) {
                contextTracker.update(inputTokens)
            }
            return {toolCalls: pendingToolCalls, text: accumulatedText, aborted: false}
        } catch (err) {
            if (isAbortError(err)) {
                const e2eMs = Date.now() - requestStart
                yield {
                    type: 'llm_done',
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    stopReason: 'abort',
                    ttftMs,
                    e2eMs,
                    tps: 0,
                }
            } else {
                yield makeLlmError(err instanceof Error ? err.message : String(err), outputTokens)
            }
            throw err
        }
    }
}

// ═══════════════════════════════════════════════
// 模块级 helper
// ═══════════════════════════════════════════════

/** StreamChunk → AgentEvent 映射,null 表示不产生事件(usage / done / 空 text) */
function mapChunkToEvent(chunk: StreamChunk, pendingToolCalls: ToolCallContent[]): AgentEvent | null {
    switch (chunk.type) {
        case 'text':
            return chunk.text ? {type: 'text', text: chunk.text} : null
        case 'thinking':
            return {type: 'thinking', text: chunk.thinking ?? ''}
        case 'tool_call': {
            if (chunk.toolCall) pendingToolCalls.push(chunk.toolCall)
            return null
        }
        case 'error':
            return {type: 'error', error: chunk.error ?? 'unknown error'}
        default:
            return null // usage / done 不产生业务事件
    }
}

/** 构造 llm_error 事件(兼容 exactOptionalPropertyTypes) */
function makeLlmError(error: string, partialTokens: number): AgentEvent {
    return partialTokens > 0
        ? {type: 'llm_error', error, partialOutputTokens: partialTokens}
        : {type: 'llm_error', error}
}

/** djb2 字符串哈希 — 用于 Prompt Cache 破裂检测(不需要密码学安全性) */
function simpleHash(str: string): string {
    let hash = 5381
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
    }
    return (hash >>> 0).toString(36)
}

/**
 * 判断是否为 abort 错误。
 * Node.js 原生 fetch 抛 AbortError(name='AbortError'),
 * 但 LangChain 等库可能包装为普通 Error,message 含 "aborted"。
 *
 * 外部使用方(dispatch-agent.ts / useChat.ts)通过 agent-loop.js 的 re-export 访问。
 */
export function isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    if (err.name === 'AbortError') return true
    if (err.message.toLowerCase().includes('aborted')) return true
    return false
}

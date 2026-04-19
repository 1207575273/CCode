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
 *
 * ⚠️ 消息格式检查清单（修改本文件或 provider 转换时必查）：
 *
 *   □ 雷区一：每个 tool_call 都有对应的 tool_result？
 *             assistant(tool_calls) → user(tool_results) 严格成对？
 *             异常时也必须产生 tool_result（不能让 tool_call 成孤儿）？
 *   □ 雷区二：工具异常时完整 stack 传回了 LLM（不是空字符串、不是只有 message）？
 *   □ 雷区三：SystemPrompt 未被上下文裁剪截断？SubAgent 不继承主 Agent prompt？
 *   □ 雷区四：循环退出条件只看 toolCalls.length === 0？不看 text 有没有内容？
 */

import type {LLMProvider} from '@providers/provider.js'
import {summarizeArgs} from './args-summarizer.js'
import type {ToolRegistry} from '@tools/core/registry.js'
import type {Message, MessageContent, StreamChunk, ToolCallContent, ToolResultContent} from './types.js'
import {classifyToolCalls, executeSafeToolsInParallel} from './parallel-executor.js'
import type {HookManager} from '@hooks/hook-manager.js'
import {contextTracker} from './context-tracker.js'
import {RepetitionDetector} from './repetition-detector.js'
import {executeToolPipeline, type ToolPipelineDeps} from './tool-pipeline.js'
import type {AgentEvent} from './agent-events.js'
import {dbg} from '../debug.js'

// AgentEvent 及其子 union、UserQuestion 等类型定义在 ./agent-events.ts,
// 此处 re-export 保持所有外部 import 的向后兼容(P1-01,docs/plans/20260420012229_agent-loop重构评审.md)
export type {
    AgentEvent,
    BusinessEvent,
    ObservabilityEvent,
    SubagentEvent,
    PlanningEvent,
    UserQuestion,
    UserQuestionOption,
    UserQuestionResult,
} from './agent-events.js'

// ═══════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════

export interface AgentConfig {
    model: string
    /** provider 名称，记录到 llm_start 事件 */
    provider: string
    signal?: AbortSignal | undefined
    /** 是否启用并行工具执行（默认 true） */
    parallelTools?: boolean | undefined
    /** 最大并行工具数（默认 5） */
    maxParallelTools?: number | undefined
    /** 系统提示词，注入到每次 LLM 调用的首条 system message */
    systemPrompt?: string | undefined
    /** 最大轮次（默认 20，子 Agent 可设更小值防止过长执行） */
    maxTurns?: number | undefined
    /** 标记为侧链（子 Agent），跳过权限检查弹窗 */
    isSidechain?: boolean | undefined
    /** 子 Agent ID（日志和事件用） */
    agentId?: string | undefined
    /** 当前会话 ID（子 Agent JSONL 需要关联父会话） */
    sessionId?: string | undefined
    /** 标记非交互模式，工具不可弹出用户界面 */
    nonInteractive?: boolean | undefined
    /** Hook 管理器（可选，注入后启用 PreToolUse / PostToolUse 钩子） */
    hookManager?: HookManager | undefined
    /** 配置快照（透传到 ToolContext，避免子 Agent 重复读磁盘） */
    config?: import('@config/config-manager.js').CCodeConfig | undefined
    /** 最少执行轮次（仅 isSidechain 模式生效，防止弱模型提前退出） */
    minTurns?: number | undefined
    /** 标记后台执行模式（run_in_background），禁用 minTurns 续跑，避免无用 LLM 调用挂起 */
    isBackground?: boolean | undefined
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 主 Agent 默认最大轮次 */
const DEFAULT_MAX_TURNS = 100

// 截断常量和函数统一由 ./result-truncator.ts 提供(docs/plans/20260420012229_agent-loop重构评审.md P0-02)

// ═══════════════════════════════════════════════
// AgentLoop 类
// ═══════════════════════════════════════════════

export class AgentLoop {
    readonly #provider: LLMProvider
    readonly #registry: ToolRegistry
    readonly #config: AgentConfig
    /** 上一次 LLM 调用的参数指纹（用于 Prompt Cache 破裂检测） */
    #lastCacheFingerprint: string | null = null
    #llmCallIndex = 0
    /** 工具调用重复检测器（防止弱模型陷入循环调用） */
    readonly #repetitionDetector = new RepetitionDetector()
    /** 外部请求优雅停止 — 当前轮结束后退出循环 */
    #stopRequested = false

    constructor(
        provider: LLMProvider,
        registry: ToolRegistry,
        config: AgentConfig,
    ) {
        this.#provider = provider
        this.#registry = registry
        this.#config = config
    }

    /** 暴露 provider 给 StreamableTool（子 Agent 需要继承 provider） */
    get provider(): LLMProvider {
        return this.#provider
    }

    /** 暴露 registry 给 StreamableTool（子 Agent 需要 cloneWithout） */
    get registry(): ToolRegistry {
        return this.#registry
    }

    /** 外部请求优雅停止 — 当前轮结束后退出循环 */
    requestStop(): void {
        this.#stopRequested = true
    }

    /**
     * 主循环：LLM 调用 → [工具执行 → LLM 调用]* → 文本回复
     *
     * 返回类型说明（2026-04-17 从 AsyncIterable 收紧到 AsyncGenerator）：
     * - 实现是 async function*，运行时对象天然就是 AsyncGenerator
     * - 原先标注 AsyncIterable<T> 属于向上转型，丢失了 return()/throw()/TReturn
     *   的类型信息，且与同文件内部方法的 AsyncGenerator 标注不一致
     * - 现在显式 TReturn=void（run() 所有 return 语句无值）、TNext=unknown
     *   （从不消费 next(x) 的参数），让未来误增 return 值会被编译器挡下
     * - 调用方全部只用 for await...of，改动零破坏，但获得 .return()/.throw()
     *   的类型级能力（未来需要主动清理或测试错误注入时可直接使用）
     *
     * 详细原理、改造取舍、性能误区：
     *   docs/experience/20260417150016_AsyncIterable与AsyncGenerator的魔法细节.md
     */
    async* run(messages: Message[]): AsyncGenerator<AgentEvent, void, unknown> {
        // 直接引用传入数组（不复制）。ContextManager 通过 getHistoryRef() 传入，
        // run() 中追加的 assistant + tool_result 自动反映到 ContextManager 内部。
        const history = messages
        const maxTurns = this.#config.maxTurns ?? DEFAULT_MAX_TURNS
        const minToolRounds = this.#config.minTurns ?? 0
        /** 实际执行了工具的轮次数（不含纯文本轮） */
        let toolRounds = 0

        for (let turn = 0; turn < maxTurns; turn++) {
            // 检查点 1：新一轮开始前（安全 — history 末尾是 tool_result 或初始 user 消息）
            if (this.#stopRequested) {
                yield {type: 'done', reason: 'stopped'}
                return
            }

            const llmResult = yield* this.#callLLM(history)
            if (llmResult.aborted) return

            // 追加 assistant 消息到 history（text + tool_calls 摘要）
            // tool_call 只记录 id/name，不记录完整 args（args 可能包含 write_file 的整个文件内容，
            // 放入 history 会导致每轮 LLM 调用 token 数爆炸）
            const assistantContent: MessageContent[] = []
            if (llmResult.text) {
                assistantContent.push({type: 'text', text: llmResult.text})
            }
            for (const tc of llmResult.toolCalls) {
                assistantContent.push({
                    type: 'tool_call',
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    args: summarizeArgs(tc.toolName, tc.args),  // 精简摘要：保留关键信息（命令/路径/模式），不含大段内容
                })
            }
            if (assistantContent.length > 0) {
                history.push({role: 'assistant', content: assistantContent})
            }

            if (llmResult.toolCalls.length === 0) {
                // 续跑检测：前台 SubAgent 且工具轮次不足时注入继续消息
                // 后台 SubAgent 不续跑——任务完成即退出，避免无用 LLM 调用挂起导致 session_end 缺失
                if (toolRounds < minToolRounds && this.#config.isSidechain && !this.#config.isBackground) {
                    history.push({
                        role: 'user',
                        content: 'You have not completed the task yet. Continue executing tools to finish the task. Do NOT just describe what to do — actually call tools.',
                    })
                    continue
                }
                yield {type: 'done', reason: 'complete'}
                return
            }

            toolRounds++
            yield* this.#executeToolCalls(llmResult.toolCalls, history)

            // 检查点 2：工具执行完毕后（安全 — tool_result 已写入 history）
            if (this.#stopRequested) {
                yield {type: 'done', reason: 'stopped'}
                return
            }
        }

        // 超过最大轮次：以 done + max_turns 结束，不再 yield error（调用方可按 reason 区分）
        yield {type: 'done', reason: 'max_turns'}
    }

    // ─────────────────────────────────────────────
    // LLM 调用
    // ─────────────────────────────────────────────

    /**
     * 调用 LLM 并收集流式输出。
     *
     * yield: llm_start → text* → llm_done | llm_error
     * return: 收集到的工具调用列表 + 是否因错误中止
     */
    async* #callLLM(
        history: Message[],
    ): AsyncGenerator<AgentEvent, { toolCalls: ToolCallContent[]; text: string; aborted: boolean }> {
        const chatRequest = {
            model: this.#config.model,
            messages: history,
            tools: this.#registry.toToolDefinitions(),
            ...(this.#config.signal !== undefined ? {signal: this.#config.signal} : {}),
            ...(this.#config.systemPrompt !== undefined ? {systemPrompt: this.#config.systemPrompt} : {}),
        }

        yield {
            type: 'llm_start',
            provider: this.#config.provider,
            model: this.#config.model,
            messageCount: history.length,
            ...(this.#config.systemPrompt !== undefined ? {systemPrompt: this.#config.systemPrompt} : {}),
        }

        const pendingToolCalls: ToolCallContent[] = []
        let accumulatedText = ''
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheWriteTokens = 0
        // 从 done chunk 中取 stopReason，经 ProviderWrapper 标准化后直接使用
        let doneStopReason = 'end_turn'

        // 性能层：计时变量
        const requestStart = Date.now()
        let firstContentChunk = false
        let ttftMs = 0

        try {
            for await (const chunk of this.#provider.chat(chatRequest)) {
                // 性能层：首个有内容的 chunk 才算 TTFT
                // 部分 Provider 第一个 chunk 可能是 message_start 或空 content_block_start，
                // 只在 text / thinking / tool_call 类型时才记录
                if (!firstContentChunk && (chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_call')) {
                    ttftMs = Date.now() - requestStart
                    firstContentChunk = true
                }

                const mapped = this.#mapChunk(chunk, pendingToolCalls)
                if (mapped) {
                    if (mapped.type === 'text' && 'text' in mapped) accumulatedText += mapped.text
                    if (mapped.type === 'error') {
                        const errorMsg = chunk.error ?? 'unknown error'
                        // Provider 将 abort 错误包装为 error chunk（不抛出）→ 重新抛出使 catch 路径生效
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

            // 性能层：E2E + TPS 计算
            const e2eMs = Date.now() - requestStart
            // 纯工具调用场景：Anthropic 的 tool_call 是流结束后才 yield，
            // ttftMs ≈ e2eMs 使 generationMs ≈ 0。此时退化用 e2eMs 作为分母，
            // 给出"整体吞吐率"而非"纯 generation 阶段吞吐率"。
            const generationMs = e2eMs - ttftMs
            const tpsBase = generationMs > 50 ? generationMs : e2eMs  // 50ms 阈值避免极小值放大噪声
            const tps = tpsBase > 0 && outputTokens > 0
                ? Math.round(outputTokens / (tpsBase / 1000) * 10) / 10
                : 0
            dbg(`[PERF] TTFT=${ttftMs}ms E2E=${e2eMs}ms TPS=${tps} tokens/s (base=${tpsBase}ms)\n`)

            // Prompt Cache 破裂检测：systemPrompt + tools 指纹变化 → 缓存失效
            this.#llmCallIndex++
            const fingerprint = simpleHash(
                (this.#config.systemPrompt ?? '') +
                JSON.stringify(this.#registry.toToolDefinitions().map(t => t.name)),
            )
            if (this.#lastCacheFingerprint !== null && this.#lastCacheFingerprint !== fingerprint) {
                // 指纹变化 = 缓存前缀不同，Prompt Cache 必然 miss
                dbg(`[CACHE-BREAK] LLM call #${this.#llmCallIndex}: prompt/tools fingerprint changed (${this.#lastCacheFingerprint} → ${fingerprint})\n`)
            } else if (this.#llmCallIndex > 1 && cacheReadTokens === 0 && inputTokens > 2000) {
                // 指纹没变但 cacheRead=0，可能是 TTL 过期或 API 侧未命中
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
                tps
            }
            // 更新上下文窗口追踪（精确值来自 API 返回的 inputTokens）
            // 仅主 Agent 更新 — 子 Agent（isSidechain）有独立上下文，不应覆盖主 Agent 的追踪值
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
                    tps: 0
                }
            } else {
                yield makeLlmError(err instanceof Error ? err.message : String(err), outputTokens)
            }
            throw err
        }
    }

    /** StreamChunk → AgentEvent 映射，null 表示不产生事件 */
    #mapChunk(chunk: StreamChunk, pendingToolCalls: ToolCallContent[]): AgentEvent | null {
        switch (chunk.type) {
            case 'text':
                return chunk.text ? {type: 'text', text: chunk.text} : null
            case 'thinking':
                return {type: 'thinking', text: chunk.thinking ?? ''}
            case 'tool_call': {
                if (chunk.toolCall) pendingToolCalls.push(chunk.toolCall);
                return null
            }
            case 'error':
                return {type: 'error', error: chunk.error ?? 'unknown error'}
            default:
                return null // usage / done 不产生业务事件
        }
    }

    // ─────────────────────────────────────────────
    // 工具执行
    // ─────────────────────────────────────────────

    /**
     * 分发工具调用：parallelTools=false 时全部串行；否则安全工具并行、危险工具串行。
     */
    async* #executeToolCalls(toolCalls: ToolCallContent[], history: Message[]): AsyncGenerator<AgentEvent> {
        // parallelTools === false → 全部串行（兼容模式）
        if (this.#config.parallelTools === false) {
            for (const tc of toolCalls) {
                yield* this.#executeOneTool(tc, history)
            }
            return
        }

        // 分组：safe 并行，dangerous 串行
        const {safe, dangerous} = classifyToolCalls(toolCalls, this.#registry)

        if (safe.length + dangerous.length > 1) {
            process.stderr.write(`[parallel] ${toolCalls.length} tools → safe: ${safe.map(t => t.toolName).join(',')} | dangerous: ${dangerous.map(t => t.toolName).join(',')}\n`)
        }

        // 1. 并行执行安全工具 — 每个工具跑完整 pipeline,护栏与串行路径一致
        if (safe.length > 0) {
            const events: AgentEvent[] = []
            const ctx = buildToolContext(this.#provider, this.#registry, this.#config, history)
            const deps: ToolPipelineDeps = {
                registry: this.#registry,
                repetitionDetector: this.#repetitionDetector,
                ...(this.#config.hookManager !== undefined ? {hookManager: this.#config.hookManager} : {}),
                ...(this.#config.isSidechain !== undefined ? {isSidechain: this.#config.isSidechain} : {}),
            }
            const outcomes = await executeSafeToolsInParallel(
                safe, deps, (e) => events.push(e), ctx, this.#config.maxParallelTools,
            )
            // yield 收集到的事件
            for (const e of events) {
                yield e
            }
            // 所有并行工具的 tool_result 合并到一条 user 消息(Anthropic 要求同一批 tool_result 在同条消息)
            const toolResults: ToolResultContent[] = outcomes.map(o => o.toolResult)
            if (toolResults.length > 0) {
                history.push({role: 'user', content: toolResults})
            }
            // 每个工具的 warn / postHookFeedbacks 按原始顺序追加为独立 user 消息
            for (const o of outcomes) {
                if (o.warnMessage !== undefined) {
                    history.push({role: 'user', content: o.warnMessage})
                }
                if (o.postHookFeedbacks !== undefined) {
                    for (const fb of o.postHookFeedbacks) {
                        history.push({role: 'user', content: fb})
                    }
                }
            }
        }

        // 2. 串行执行危险工具(含 StreamableTool,如 dispatch_agent)
        for (const tc of dangerous) {
            yield* this.#executeOneTool(tc, history)
        }
    }

    /**
     * 执行单个工具调用 — 串行路径。
     *
     * 完整执行管道(重复检测、权限、Pre/Post Hook、核心执行、截断)统一由
     * executeToolPipeline 承担。本函数只负责:
     *   - 构造 ToolContext 与 pipeline deps
     *   - yield* pipeline 透传事件(tool_start / permission_request / post_tool_feedback / tool_done 等)
     *   - 按 outcome 顺序追加 history(tool_result → warn → postHookFeedbacks)
     *
     * 详见 src/core/tool-pipeline.ts 与 docs/plans/20260420012229_agent-loop重构评审.md S-P0.1。
     */
    async* #executeOneTool(tc: ToolCallContent, history: Message[]): AsyncGenerator<AgentEvent> {
        const ctx = buildToolContext(this.#provider, this.#registry, this.#config, history, tc.toolCallId)
        const deps: ToolPipelineDeps = {
            registry: this.#registry,
            repetitionDetector: this.#repetitionDetector,
            ...(this.#config.hookManager !== undefined ? {hookManager: this.#config.hookManager} : {}),
            ...(this.#config.isSidechain !== undefined ? {isSidechain: this.#config.isSidechain} : {}),
        }

        const outcome = yield* executeToolPipeline(tc, ctx, deps)

        // 按 outcome 顺序追加 history(并行路径走 parallel-executor,在那里做合并追加)
        history.push({role: 'user', content: [outcome.toolResult]})
        if (outcome.warnMessage !== undefined) {
            history.push({role: 'user', content: outcome.warnMessage})
        }
        if (outcome.postHookFeedbacks !== undefined) {
            for (const fb of outcome.postHookFeedbacks) {
                history.push({role: 'user', content: fb})
            }
        }
    }

}

// ═══════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════

/**
 * 判断是否为 abort 错误。
 * Node.js 原生 fetch 抛 AbortError（name='AbortError'），
 * 但 LangChain 等库可能包装为普通 Error，message 含 "aborted"。
 */
export function isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    if (err.name === 'AbortError') return true
    if (err.message.toLowerCase().includes('aborted')) return true
    return false
}

/** 构造 llm_error 事件（兼容 exactOptionalPropertyTypes） */
function makeLlmError(error: string, partialTokens: number): AgentEvent {
    return partialTokens > 0
        ? {type: 'llm_error', error, partialOutputTokens: partialTokens}
        : {type: 'llm_error', error}
}

/** 构建 ToolContext，兼容 exactOptionalPropertyTypes（不传 undefined 值） */
function buildToolContext(
    provider: LLMProvider,
    registry: ToolRegistry,
    config: AgentConfig,
    history?: ReadonlyArray<Message>,
    toolCallId?: string,
): import('@tools/core/types.js').ToolContext {
    const ctx: import('@tools/core/types.js').ToolContext = {
        cwd: process.cwd(),
        provider,
        providerName: config.provider,
        model: config.model,
        registry,
    }
    if (config.signal !== undefined) {
        ctx.signal = config.signal
    }
    if (config.sessionId !== undefined) {
        ctx.sessionId = config.sessionId
    }
    if (config.nonInteractive) {
        ctx.nonInteractive = config.nonInteractive
    }
    if (config.systemPrompt !== undefined) {
        ctx.systemPrompt = config.systemPrompt
    }
    if (config.config !== undefined) {
        ctx.config = config.config
    }
    if (history !== undefined) {
        ctx.history = history
    }
    if (toolCallId !== undefined) {
        ctx.toolCallId = toolCallId
    }
    return ctx
}

/** djb2 字符串哈希 — 用于 Prompt Cache 破裂检测（不需要密码学安全性） */
function simpleHash(str: string): string {
    let hash = 5381
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
    }
    return (hash >>> 0).toString(36)
}

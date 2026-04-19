// src/core/history-writer.ts

/**
 * HistoryWriter — 对 Message[] 历史的所有写操作进行收敛。
 *
 * 背景(docs/plans/20260420012229_agent-loop重构评审.md P0-03 第 10 项职责 + 雷区一升级):
 * 原先 history.push 散落在 AgentLoop.run / #executeOneTool / #executeToolCalls 多处,
 * "每个 tool_call 必有配对 tool_result"(雷区一)只依赖注释约定。
 * 本类把 history 写操作收敛到 4 个语义化 API,并在运行时强制成对校验。
 *
 * 公开 API(任何历史写入必经 writer,不再直接 push):
 *   appendAssistant(text, toolCalls)   — assistant 消息,含 tool_call 摘要
 *   appendToolResult(result)            — 单个 tool_result(串行路径用)
 *   appendToolResults(results)          — 一批 tool_result 合并一条 user(并行路径用)
 *   appendSystemNote(text)              — 续跑提示 / warn / PostHook feedback 等
 *
 * 雷区一运行时防御:
 *   - 每个 tool_call 登记到 pendingToolCallIds
 *   - 每次 appendToolResult(s) 从 pending 里删除;若 ID 不在 pending → 抛 Error
 *   - 避免"assistant 有 tool_call 但 history 漏了 tool_result"导致 Anthropic API 400
 */

import type {Message, MessageContent, ToolCallContent, ToolResultContent} from './types.js'
import {summarizeArgs} from './args-summarizer.js'

export class HistoryWriter {
    readonly #history: Message[]
    readonly #pendingToolCallIds = new Set<string>()

    constructor(history: Message[]) {
        this.#history = history
        this.#seedPendingFromExisting()
    }

    /**
     * 追加 assistant 消息。text 可空,toolCalls 可空。
     * tool_call 部分使用 summarizeArgs 精简后入 history(不保存完整 args 避免 token 爆炸)。
     */
    appendAssistant(text: string, toolCalls: ReadonlyArray<ToolCallContent>): void {
        const content: MessageContent[] = []
        if (text) {
            content.push({type: 'text', text})
        }
        for (const tc of toolCalls) {
            content.push({
                type: 'tool_call',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: summarizeArgs(tc.toolName, tc.args),
            })
            this.#pendingToolCallIds.add(tc.toolCallId)
        }
        if (content.length > 0) {
            this.#history.push({role: 'assistant', content})
        }
    }

    /**
     * 追加单个 tool_result(串行路径)。
     * 若 toolCallId 不在 pending(说明没有对应的 tool_call),抛 Error — 雷区一硬拦截。
     */
    appendToolResult(result: ToolResultContent): void {
        this.#assertPairedAndConsume(result.toolCallId)
        this.#history.push({role: 'user', content: [result]})
    }

    /**
     * 追加一批 tool_result 合并为一条 user 消息(并行路径)。
     * Anthropic 协议要求同一轮的所有 tool_result 在同一条 user 消息里,
     * 故并行工具必须走本 API 而不是多次 appendToolResult。
     *
     * 原子性:先全量 validate,全部合法再 consume + push。若中途发现 orphan,
     * 抛异常时 pending 状态保持不变,history 也不追加,避免部分 consume
     * 导致后续 tool_result 无法正常配对。
     */
    appendToolResults(results: ReadonlyArray<ToolResultContent>): void {
        if (results.length === 0) return
        // Pass 1: 全部 validate,任何一个 orphan 都抛出(pending 不动)
        for (const r of results) {
            this.#assertPaired(r.toolCallId)
        }
        // Pass 2: 全部合法,统一 consume + push
        for (const r of results) {
            this.#pendingToolCallIds.delete(r.toolCallId)
        }
        this.#history.push({role: 'user', content: [...results]})
    }

    /**
     * 追加一条 user 字符串消息。用于:
     *   - minTurns 未达标时的续跑提示
     *   - RepetitionDetector warn 警告
     *   - PostToolUse Hook additionalContext 反馈
     */
    appendSystemNote(text: string): void {
        this.#history.push({role: 'user', content: text})
    }

    /** 只读历史引用(供需要读 history 的消费者,如 buildToolContext) */
    get history(): ReadonlyArray<Message> {
        return this.#history
    }

    /** 当前未配对的 tool_call ID 列表(调试用) */
    get pendingToolCallIds(): ReadonlyArray<string> {
        return [...this.#pendingToolCallIds]
    }

    /** 仅 validate 不消费(供 appendToolResults 的原子化 validate 阶段使用) */
    #assertPaired(toolCallId: string): void {
        if (!this.#pendingToolCallIds.has(toolCallId)) {
            throw new Error(
                `HistoryWriter: tool_result '${toolCallId}' has no matching pending tool_call. ` +
                `This indicates a programming error in AgentLoop/Pipeline. ` +
                `Pending: [${[...this.#pendingToolCallIds].join(', ')}]`,
            )
        }
    }

    #assertPairedAndConsume(toolCallId: string): void {
        this.#assertPaired(toolCallId)
        this.#pendingToolCallIds.delete(toolCallId)
    }

    /**
     * 扫描现有 history,把没有配对 tool_result 的 tool_call 塞进 pending(支持 resume 场景)。
     * Message.content 可以是 string / MessageContent / MessageContent[] 三种形态,
     * 本方法需统一处理(单对象和数组都要扫,string 跳过)。
     */
    #seedPendingFromExisting(): void {
        const seenCalls = new Set<string>()
        const seenResults = new Set<string>()
        for (const msg of this.#history) {
            if (typeof msg.content === 'string') continue
            // content 既可能是数组也可能是单 MessageContent 对象,统一包裹后扫描
            const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]
            for (const c of blocks) {
                if (typeof c !== 'object' || c === null || !('type' in c)) continue
                if (c.type === 'tool_call') {
                    seenCalls.add((c as ToolCallContent).toolCallId)
                } else if (c.type === 'tool_result') {
                    seenResults.add((c as ToolResultContent).toolCallId)
                }
            }
        }
        for (const id of seenCalls) {
            if (!seenResults.has(id)) this.#pendingToolCallIds.add(id)
        }
    }
}

// src/core/tool-pipeline.ts

/**
 * executeToolPipeline — 单个工具调用的完整执行管道。
 *
 * 背景(docs/plans/20260420012229_agent-loop重构评审.md P0-01):
 * 重构前 agent-loop.#executeOneTool(串行,165 行)与 parallel-executor.executeSingleTool
 * (并行,72 行)各自实现了不同的执行路径,并行路径静默丢失了 RepetitionDetector、
 * Pre/PostHook、tool_done.meta 等护栏。本管道作为唯一的工具执行路径,被两侧复用:
 *
 *   - 串行:agent-loop.#executeOneTool 直接 `yield* executeToolPipeline(...)`
 *   - 并行:parallel-executor 对每个工具跑 pipeline,合并 outcome.toolResult 到一条 user 消息
 *
 * 关键设计:pipeline 本身**不直接 push history**,而是通过 return 值返回"要追加的内容",
 * 由调用方按顺序写入。这是为了并行路径能把多个工具的 tool_result 合并到同一条 user
 * 消息(Anthropic 协议要求同一批 tool_result 必须在同一条 message 里)。
 *
 * 流程:tool_start → 重复检测 → 权限检查 → PreToolUse Hook
 *       → 核心执行(registry.execute 或 StreamableTool.stream)
 *       → 构造 tool_result(含截断)→ PostToolUse Hook + Reflection 反馈
 *       → tool_done
 */

import type {ToolCallContent, ToolResultContent} from './types.js'
import type {ToolRegistry} from '@tools/core/registry.js'
import type {ToolContext, ToolResult} from '@tools/core/types.js'
import {isStreamableTool} from '@tools/core/types.js'
import type {HookManager} from '@hooks/hook-manager.js'
import type {AgentEvent} from './agent-loop.js'
import type {RepetitionDetector} from './repetition-detector.js'
import {truncate, truncateForSummary, truncateForFull, truncateForLLM} from './result-truncator.js'
import {dbg} from '../debug.js'

// ═══════════════════════════════════════════════
// 接口
// ═══════════════════════════════════════════════

/** pipeline 运行时依赖(避免将整个 AgentLoop 作为闭包透传) */
export interface ToolPipelineDeps {
    registry: ToolRegistry
    repetitionDetector: RepetitionDetector
    hookManager?: HookManager | undefined
    /** 子 Agent 场景,跳过权限弹窗(主 Agent 派发即授权) */
    isSidechain?: boolean | undefined
}

/**
 * pipeline 的产出 — 调用方据此构造 history 追加。
 *
 * 追加顺序(按本对象字段顺序):
 *   1. toolResult(必有,即便 block/rejected 也带 isError 状态)
 *   2. warnMessage(repetition warn 级别时有)
 *   3. postHookFeedbacks(PostToolUse Hook 返回 additionalContext 时有,按 hook 顺序)
 */
export interface ToolPipelineOutcome {
    toolResult: ToolResultContent
    warnMessage?: string
    postHookFeedbacks?: string[]
    /** 提前终止原因(调试/日志用;工具实际没跑或跑到一半被拦) */
    terminated?: 'repetition_block' | 'rejected' | 'prehook_block'
}

// ═══════════════════════════════════════════════
// pipeline
// ═══════════════════════════════════════════════

export async function* executeToolPipeline(
    tc: ToolCallContent,
    ctx: ToolContext,
    deps: ToolPipelineDeps,
): AsyncGenerator<AgentEvent, ToolPipelineOutcome> {
    yield {type: 'tool_start', toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.args}

    // ─── 1. 重复检测 ───
    const verdict = deps.repetitionDetector.check(tc)
    if (verdict.action === 'block') {
        dbg(`[REPETITION-BLOCK] ${tc.toolName} × ${verdict.count}, skipping execution\n`)
        yield {
            type: 'tool_done',
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            durationMs: 0,
            success: false,
            resultSummary: `循环调用已拦截 (${tc.toolName} × ${verdict.count})`,
        }
        return {
            toolResult: {type: 'tool_result', toolCallId: tc.toolCallId, result: verdict.message, isError: true},
            terminated: 'repetition_block',
        }
    }

    // ─── 2. 权限检查 ───
    const needsPermission = !deps.isSidechain && deps.registry.isDangerous(tc.toolName)
    if (needsPermission) {
        let resolvePermission!: (v: boolean) => void
        const promise = new Promise<boolean>(r => {
            resolvePermission = r
        })
        yield {type: 'permission_request', toolName: tc.toolName, args: tc.args, resolve: resolvePermission}
        const allowed = await promise
        if (!allowed) {
            yield {
                type: 'tool_done',
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                durationMs: 0,
                success: false,
                resultSummary: 'rejected by user',
            }
            return {
                toolResult: {type: 'tool_result', toolCallId: tc.toolCallId, result: 'rejected by user', isError: true},
                terminated: 'rejected',
            }
        }
        yield {type: 'permission_grant', toolName: tc.toolName, always: false}
    }

    // ─── 3. PreToolUse Hook ───
    let toolArgs = tc.args
    if (deps.hookManager) {
        const preResults = await deps.hookManager.run('PreToolUse', {
            trigger: tc.toolName,
            env: {CCODE_TOOL_NAME: tc.toolName, CCODE_TOOL_CALL_ID: tc.toolCallId},
            stdin: JSON.stringify({toolName: tc.toolName, args: tc.args}),
        })
        for (const r of preResults) {
            if (!r) continue
            if (r['decision'] === 'block') {
                const reason = typeof r['reason'] === 'string' ? r['reason'] : 'blocked by hook'
                yield {
                    type: 'tool_done',
                    toolName: tc.toolName,
                    toolCallId: tc.toolCallId,
                    durationMs: 0,
                    success: false,
                    resultSummary: reason,
                }
                return {
                    toolResult: {
                        type: 'tool_result',
                        toolCallId: tc.toolCallId,
                        result: `blocked: ${reason}`,
                        isError: true,
                    },
                    terminated: 'prehook_block',
                }
            }
            if (r['decision'] === 'modify' && typeof r['modifiedArgs'] === 'object' && r['modifiedArgs'] !== null) {
                toolArgs = r['modifiedArgs'] as Record<string, unknown>
            }
        }
    }

    // ─── 4. 核心执行 ───
    // 【雷区一防御】工具执行必须 try/catch,确保任何异常都产生 tool_result,
    // 绝不让 assistant 消息中的 tool_call 成为孤儿(无对应 tool_result)。
    const start = Date.now()
    const tool = deps.registry.get(tc.toolName)
    let result: ToolResult
    try {
        if (tool && isStreamableTool(tool)) {
            // 流式工具(如 dispatch_agent):yield* 透传中间事件,return 值为最终结果
            result = yield* (tool.stream(toolArgs, ctx) as AsyncGenerator<AgentEvent, ToolResult>)
        } else {
            result = await deps.registry.execute(tc.toolName, toolArgs, ctx)
        }
    } catch (err) {
        // 【雷区二防御】异常的完整 stack 传回 LLM,让模型能定位错误并自我纠错
        const errDetail = err instanceof Error
            ? `${err.message}\n${err.stack ?? ''}`
            : String(err)
        result = {success: false, output: '', error: errDetail}
    }
    const durationMs = Date.now() - start

    // ─── 5. 构造 tool_result(含截断)───
    const toolResultRaw = result.success
        ? result.output
        : [result.output, result.error].filter(Boolean).join('\n') || 'error'
    const toolResultText = truncateForLLM(toolResultRaw, tc.toolName)

    const toolResultContent: ToolResultContent = {
        type: 'tool_result',
        toolCallId: tc.toolCallId,
        result: toolResultText,
        ...(result.success === false ? {isError: true as const} : {}),
    }

    // ─── 6. repetition warn(注入警告消息,让 LLM 下一轮看到)───
    let warnMessage: string | undefined
    if (verdict.action === 'warn') {
        dbg(`[REPETITION-WARN] ${tc.toolName} × ${verdict.count}\n`)
        warnMessage = deps.repetitionDetector.buildWarningMessage(verdict.toolName, verdict.count)
    }

    // ─── 7. PostToolUse Hook(多条 additionalContext 按顺序保留)───
    const postHookFeedbacks: string[] = []
    if (deps.hookManager) {
        const postResults = await deps.hookManager.run('PostToolUse', {
            trigger: tc.toolName,
            env: {CCODE_TOOL_NAME: tc.toolName, CCODE_TOOL_CALL_ID: tc.toolCallId},
            stdin: JSON.stringify({
                toolName: tc.toolName,
                result: {success: result.success, output: truncate(result.output, 1000)},
            }),
        })
        for (const r of postResults) {
            if (!r) continue
            const additionalContext = r['additionalContext']
            if (typeof additionalContext === 'string' && additionalContext.trim()) {
                yield {
                    type: 'post_tool_feedback',
                    toolName: tc.toolName,
                    toolCallId: tc.toolCallId,
                    feedback: additionalContext,
                }
                postHookFeedbacks.push(`[PostToolUse feedback for ${tc.toolName}]: ${additionalContext}`)
            }
        }
    }

    // ─── 8. tool_done ───
    const rawOutput = result.success ? result.output : (result.error ?? 'error')
    const resultSummary = truncateForSummary(rawOutput)
    const resultFull = truncateForFull(rawOutput)

    yield {
        type: 'tool_done',
        toolName: tc.toolName,
        toolCallId: tc.toolCallId,
        durationMs,
        success: result.success,
        resultSummary,
        resultFull,
        ...(result.meta !== undefined ? {meta: result.meta} : {}),
    }

    const outcome: ToolPipelineOutcome = {toolResult: toolResultContent}
    if (warnMessage !== undefined) outcome.warnMessage = warnMessage
    if (postHookFeedbacks.length > 0) outcome.postHookFeedbacks = postHookFeedbacks
    return outcome
}

// src/core/parallel-executor.ts

/**
 * parallel-executor — 并行工具执行器
 *
 * 将 LLM 返回的 tool_call 列表分为安全/危险两组，
 * 对安全工具进行并行执行（支持并发限制），
 * 通过 onEvent 回调发射 tool_start / tool_done 事件。
 */

import type { ToolCallContent } from './types.js'
import type { ToolRegistry } from '@tools/core/registry.js'
import type { ToolContext } from '@tools/core/types.js'
import { isStreamableTool } from '@tools/core/types.js'
import type { AgentEvent } from './agent-loop.js'

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/** 单个工具调用的并行执行结果 */
export interface ParallelToolResult {
  toolCallId: string
  toolName: string
  success: boolean
  output: string
  error?: string
  durationMs: number
}

/** classifyToolCalls 的返回值 */
export interface ClassifiedToolCalls {
  safe: ToolCallContent[]
  dangerous: ToolCallContent[]
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

const DEFAULT_MAX_PARALLEL = 10
const RESULT_SUMMARY_MAX_LEN = 200
const RESULT_FULL_MAX_LEN = 100_000

// ═══════════════════════════════════════════════
// 核心函数
// ═══════════════════════════════════════════════

/**
 * 将 toolCalls 按 registry 注册情况分为 safe / dangerous 两组。
 *
 * 分类规则：
 * - 工具不存在（未注册）→ dangerous
 * - 工具存在且 isDangerous() 为 true → dangerous
 * - 工具存在且 isDangerous() 为 false → safe
 */
export function classifyToolCalls(
  toolCalls: ToolCallContent[],
  registry: ToolRegistry,
): ClassifiedToolCalls {
  const safe: ToolCallContent[] = []
  const dangerous: ToolCallContent[] = []

  for (const tc of toolCalls) {
    const tool = registry.get(tc.toolName)
    // StreamableTool（如 dispatch_agent）必须走串行路径，因为需要 yield* stream()
    if (!tool || registry.isDangerous(tc.toolName) || isStreamableTool(tool)) {
      dangerous.push(tc)
    } else {
      safe.push(tc)
    }
  }

  return { safe, dangerous }
}

/**
 * 并行执行安全工具列表，通过 onEvent 发射 tool_start / tool_done 事件。
 *
 * - 使用 Promise.allSettled 确保单个工具失败不影响其他工具
 * - maxParallel 限制同时执行的工具数量，超过时分批执行
 * - 返回结果按原始 toolCalls 顺序排列
 * - resultSummary 截断到 200 字符
 */
export async function executeSafeToolsInParallel(
  toolCalls: ToolCallContent[],
  registry: ToolRegistry,
  onEvent: (event: AgentEvent) => void,
  ctx: ToolContext,
  maxParallel = DEFAULT_MAX_PARALLEL,
): Promise<ParallelToolResult[]> {
  if (toolCalls.length === 0) return []

  const results: ParallelToolResult[] = new Array(toolCalls.length)

  // 分批处理，每批最多 maxParallel 个
  for (let batchStart = 0; batchStart < toolCalls.length; batchStart += maxParallel) {
    const batch = toolCalls.slice(batchStart, batchStart + maxParallel)

    const settled = await Promise.allSettled(
      batch.map((tc) => executeSingleTool(tc, registry, onEvent, ctx)),
    )

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const originalIndex = batchStart + i
      const tc = toolCalls[originalIndex]!

      if (outcome.status === 'fulfilled') {
        results[originalIndex] = outcome.value
      } else {
        // Promise.allSettled 中 executeSingleTool 内部已处理异常，理论上不会走这里
        // 但作为防御性兜底保留
        const durationMs = 0
        results[originalIndex] = {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          success: false,
          output: '',
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          durationMs,
        }
        onEvent({
          type: 'tool_done',
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          durationMs,
          success: false,
        })
      }
    }
  }

  return results
}

// ═══════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════

async function executeSingleTool(
  tc: ToolCallContent,
  registry: ToolRegistry,
  onEvent: (event: AgentEvent) => void,
  ctx: ToolContext,
): Promise<ParallelToolResult> {
  onEvent({
    type: 'tool_start',
    toolName: tc.toolName,
    toolCallId: tc.toolCallId,
    args: tc.args,
  })

  const startTime = Date.now()

  try {
    const result = await registry.execute(tc.toolName, tc.args, ctx)
    const durationMs = Date.now() - startTime

    const rawOutput = result.success ? result.output : (result.error ?? 'error')
    const resultSummary = rawOutput.length > RESULT_SUMMARY_MAX_LEN
      ? rawOutput.slice(0, RESULT_SUMMARY_MAX_LEN) + '...'
      : rawOutput
    const resultFull = rawOutput.length > RESULT_FULL_MAX_LEN
      ? rawOutput.slice(0, RESULT_FULL_MAX_LEN) + `\n... (truncated, total ${rawOutput.length} chars)`
      : rawOutput

    onEvent({
      type: 'tool_done',
      toolName: tc.toolName,
      toolCallId: tc.toolCallId,
      durationMs,
      success: result.success,
      ...(resultSummary.length > 0 ? { resultSummary } : {}),
      resultFull,
    })

    const toolResult: ParallelToolResult = {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      success: result.success,
      output: result.output,
      durationMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
    return toolResult
  } catch (err) {
    const durationMs = Date.now() - startTime
    const errorMsg = err instanceof Error ? err.message : String(err)

    const resultSummary = errorMsg.slice(0, RESULT_SUMMARY_MAX_LEN)
    const resultFull = errorMsg.slice(0, RESULT_FULL_MAX_LEN)
    onEvent({
      type: 'tool_done',
      toolName: tc.toolName,
      toolCallId: tc.toolCallId,
      durationMs,
      success: false,
      resultSummary,
      resultFull,
    })

    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      success: false,
      output: '',
      error: errorMsg,
      durationMs,
    }
  }
}

// src/core/parallel-executor.ts

/**
 * parallel-executor — 并行工具执行器
 *
 * 将 LLM 返回的 tool_call 列表分为安全/危险两组,对安全工具并发执行。
 * 每个工具都走 executeToolPipeline(与串行路径共用同一条管道),
 * 确保并行场景下 RepetitionDetector / Pre+Post Hook / tool_done.meta 等护栏一致生效。
 *
 * 参见 docs/plans/20260420012229_agent-loop重构评审.md S-P0.1。
 */

import type { ToolCallContent } from './types.js'
import type { ToolRegistry } from '@tools/core/registry.js'
import type { ToolContext } from '@tools/core/types.js'
import { isStreamableTool } from '@tools/core/types.js'
import type { AgentEvent } from './agent-loop.js'
import { executeToolPipeline, type ToolPipelineDeps, type ToolPipelineOutcome } from './tool-pipeline.js'

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/** classifyToolCalls 的返回值 */
export interface ClassifiedToolCalls {
  safe: ToolCallContent[]
  dangerous: ToolCallContent[]
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

const DEFAULT_MAX_PARALLEL = 10

// ═══════════════════════════════════════════════
// 核心函数
// ═══════════════════════════════════════════════

/**
 * 将 toolCalls 按 registry 注册情况分为 safe / dangerous 两组。
 *
 * 分类规则:
 * - 工具不存在(未注册)→ dangerous
 * - 工具存在且 isDangerous() 为 true → dangerous
 * - 工具存在且是 StreamableTool(如 dispatch_agent)→ dangerous(需走串行,pipeline 内 yield* 透传事件)
 * - 其他 → safe
 */
export function classifyToolCalls(
  toolCalls: ToolCallContent[],
  registry: ToolRegistry,
): ClassifiedToolCalls {
  const safe: ToolCallContent[] = []
  const dangerous: ToolCallContent[] = []

  for (const tc of toolCalls) {
    const tool = registry.get(tc.toolName)
    // StreamableTool(如 dispatch_agent)必须走串行路径,否则 pipeline yield* 事件
    // 在并行 drain 中会以错乱顺序到达上层 UI
    if (!tool || registry.isDangerous(tc.toolName) || isStreamableTool(tool)) {
      dangerous.push(tc)
    } else {
      safe.push(tc)
    }
  }

  return { safe, dangerous }
}

/**
 * 并行执行安全工具列表,每个工具跑完整 pipeline。
 *
 * - 使用 Promise.allSettled 确保单个工具失败不影响其他工具
 * - maxParallel 限制同时执行的工具数量,超过时分批执行
 * - onEvent 回调接收每个 pipeline yield 的中间事件(tool_start / tool_done / post_tool_feedback 等)
 * - 返回的 outcomes 按原始 toolCalls 顺序排列,供调用方按需合并到 history
 */
export async function executeSafeToolsInParallel(
  toolCalls: ToolCallContent[],
  deps: ToolPipelineDeps,
  onEvent: (event: AgentEvent) => void,
  ctx: ToolContext,
  maxParallel = DEFAULT_MAX_PARALLEL,
): Promise<ToolPipelineOutcome[]> {
  if (toolCalls.length === 0) return []

  const results: ToolPipelineOutcome[] = new Array(toolCalls.length)

  // 分批处理,每批最多 maxParallel 个
  for (let batchStart = 0; batchStart < toolCalls.length; batchStart += maxParallel) {
    const batch = toolCalls.slice(batchStart, batchStart + maxParallel)

    const settled = await Promise.allSettled(
      batch.map((tc) => drainPipeline(tc, deps, ctx, onEvent)),
    )

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const originalIndex = batchStart + i
      const tc = toolCalls[originalIndex]!

      if (outcome.status === 'fulfilled') {
        results[originalIndex] = outcome.value
      } else {
        // pipeline 内部已 try/catch 所有异常,理论上不会走 rejected。
        // 作为雷区一的最终兜底:即便 drain 本身爆了,也要构造 tool_result 保证成对性。
        const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        results[originalIndex] = {
          toolResult: { type: 'tool_result', toolCallId: tc.toolCallId, result: errMsg, isError: true },
        }
        onEvent({
          type: 'tool_done',
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          durationMs: 0,
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

/**
 * 将 pipeline 的 AsyncGenerator 抽干为一个 Promise<Outcome>,
 * 中间事件通过 onEvent 回调实时发射。
 *
 * 这是并行场景下消费 AsyncGenerator 的标准模式 —— 不能直接 yield*
 * (父协程是 Promise.allSettled,不是 AsyncGenerator)。
 */
async function drainPipeline(
  tc: ToolCallContent,
  deps: ToolPipelineDeps,
  ctx: ToolContext,
  onEvent: (event: AgentEvent) => void,
): Promise<ToolPipelineOutcome> {
  const gen = executeToolPipeline(tc, ctx, deps)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
    onEvent(next.value)
  }
}

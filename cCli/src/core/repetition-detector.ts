// src/core/repetition-detector.ts

/**
 * RepetitionDetector — 工具调用重复检测器。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 背景
 * ═══════════════════════════════════════════════════════════════════
 *
 * 2026-04-04 cCli 实战发现：GLM-5.1 模型在 SubAgent 场景下，会对同一个文件
 * 反复调用 write_file（同样的路径、同样的内容），即使每次 tool_result 都返回
 * success，模型仍然无视，继续循环调用。
 *
 * 实测数据：
 *   - backend SubAgent: write_file("main.py", 402字符) 调了 19 次（修复前）
 *   - frontend SubAgent: write_file("vite.config.ts", 160字符) 调了 48 次（修复后仍循环）
 *
 * 尝试过的"软约束"方案（对弱模型无效）：
 *   1. write_file 返回增强反馈："✅ 文件已成功写入，无需重复写入。请继续执行下一个步骤。"
 *      （2026-04-19 复盘：该文案中"无需重复写入"反被 GLM-5 误读为"缓存问题需重写"，
 *        诱发了新一轮三次原地循环；现已改为纯事实陈述 "文件已写入: <path> (...)"，
 *        见 docs/plans/20260419225347_dispatch_agent_空result与后台超时问题诊断.md §3.4）
 *   2. SubAgent systemPrompt 加入 "NEVER call the same tool with the same arguments twice"
 *   → 对简单任务有效，对复杂任务模型完全无视
 *
 * 结论：必须在 agent-loop 层面做硬性拦截，不能只靠提示词。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 机制
 * ═══════════════════════════════════════════════════════════════════
 *
 * 对每个工具调用计算指纹（toolName + args 的 hash），维护连续相同调用的计数。
 *
 * 三级响应：
 *   - 第 1 次：正常执行（可能是合理的重试）
 *   - 第 2 次（WARN_THRESHOLD）：正常执行，但在 tool_result 后注入一条警告消息
 *     → "⚠️ 你已经用相同参数调用了 {tool} 2 次且每次都成功。请执行不同的操作。"
 *   - 第 4 次及以后（BLOCK_THRESHOLD）：跳过实际执行，直接返回拦截消息
 *     → "❌ 循环调用已被系统拦截。此操作已成功完成，不会再执行。请立即执行其他步骤。"
 *
 * 当模型调用了不同的工具（或相同工具但不同参数），连续计数自动重置。
 */

import type { ToolCallContent } from './types.js'

/** 连续相同调用达到此次数时，注入警告消息（但仍执行工具） */
const WARN_THRESHOLD = 2

/** 连续相同调用达到此次数时，跳过工具执行，直接返回拦截消息 */
const BLOCK_THRESHOLD = 4

/** 检测结果 */
export type RepetitionVerdict =
  | { action: 'allow' }
  | { action: 'warn'; count: number; toolName: string }
  | { action: 'block'; count: number; toolName: string; message: string }

/**
 * 工具调用指纹：toolName + args 的稳定序列化。
 * 不需要密码学安全性，只需要区分"相同调用"和"不同调用"。
 */
function computeFingerprint(toolName: string, args: Record<string, unknown>): string {
  // 对 args 做 key 排序后 JSON 序列化，确保 { a:1, b:2 } 和 { b:2, a:1 } 生成相同指纹
  const sortedArgs = JSON.stringify(args, Object.keys(args).sort())
  return `${toolName}::${sortedArgs}`
}

export class RepetitionDetector {
  /** 上一次工具调用的指纹 */
  #lastFingerprint: string | null = null
  /** 连续相同指纹的计数 */
  #consecutiveCount = 0

  /**
   * 记录一次工具调用，返回检测结果。
   *
   * 调用方根据 verdict 决定：
   *   - allow → 正常执行
   *   - warn  → 正常执行，但需要在 tool_result 后注入警告消息到 history
   *   - block → 跳过执行，直接用 verdict.message 作为 tool_result
   */
  check(toolCall: ToolCallContent): RepetitionVerdict {
    const fingerprint = computeFingerprint(toolCall.toolName, toolCall.args)

    if (fingerprint === this.#lastFingerprint) {
      this.#consecutiveCount++
    } else {
      this.#lastFingerprint = fingerprint
      this.#consecutiveCount = 1
    }

    if (this.#consecutiveCount >= BLOCK_THRESHOLD) {
      return {
        action: 'block',
        count: this.#consecutiveCount,
        toolName: toolCall.toolName,
        message: [
          `❌ 循环调用已被系统拦截（${toolCall.toolName} 连续 ${this.#consecutiveCount} 次相同参数）。`,
          '此操作之前已成功完成，不会再执行。',
          '请立即执行一个不同的步骤来推进任务。',
        ].join('\n'),
      }
    }

    if (this.#consecutiveCount >= WARN_THRESHOLD) {
      return {
        action: 'warn',
        count: this.#consecutiveCount,
        toolName: toolCall.toolName,
      }
    }

    return { action: 'allow' }
  }

  /**
   * 生成注入到 history 的警告消息文本。
   * 在 tool_result 之后、下一轮 LLM 调用之前注入。
   */
  buildWarningMessage(toolName: string, count: number): string {
    return [
      `⚠️ 注意：你已经用完全相同的参数调用 ${toolName} ${count} 次，每次都已成功。`,
      '这说明该操作早已完成，重复调用没有任何效果。',
      '请立即执行下一个不同的步骤（如读取文件验证、运行测试、写另一个文件等）。',
      `如果继续重复调用，系统将在第 ${BLOCK_THRESHOLD} 次自动拦截。`,
    ].join('\n')
  }

  /** 获取当前连续计数（用于日志/调试） */
  get consecutiveCount(): number {
    return this.#consecutiveCount
  }

  /** 手动重置（通常不需要，check 内部会在指纹变化时自动重置） */
  reset(): void {
    this.#lastFingerprint = null
    this.#consecutiveCount = 0
  }
}

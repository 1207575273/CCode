// src/core/context-tracker.ts

/**
 * ContextTracker — 上下文窗口使用率追踪。
 *
 * 核心数据来源：每次 LLM 调用返回的 inputTokens（精确值，API 返回）。
 * 首次调用前用 length/4 粗估，第一次 llm_done 后切换精确值。
 *
 * 模块级单例，跟踪当前会话的上下文消耗。
 */

/** 默认上下文窗口大小（tokens） */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** 默认输出预留（max_tokens） */
const DEFAULT_OUTPUT_RESERVE = 16_384

/** 状态级别阈值 */
const WARNING_THRESHOLD = 0.70
const CRITICAL_THRESHOLD = 0.85
const OVERFLOW_THRESHOLD = 0.95

export type ContextLevel = 'normal' | 'warning' | 'critical' | 'overflow'

/** 上下文窗口状态快照 */
export interface ContextWindowState {
  /** 模型的总窗口大小（tokens） */
  totalWindow: number
  /** 输出预留（max_tokens） */
  outputReserve: number
  /** 有效窗口 = total - reserve */
  effectiveWindow: number

  /** 最近一次 LLM 调用的 inputTokens（精确值） */
  lastInputTokens: number

  /** 百分比 = lastInputTokens / effectiveWindow */
  usedPercentage: number
  /** 剩余可用 tokens */
  remaining: number

  /** 状态级别 */
  level: ContextLevel
}

/** 追踪器配置 */
interface TrackerConfig {
  /** 上下文窗口大小（tokens），默认 128K */
  contextWindow?: number
  /** 输出预留（tokens），默认 16384 */
  outputReserve?: number
}

class ContextTrackerImpl {
  #totalWindow: number
  #outputReserve: number
  #effectiveWindow: number
  #lastInputTokens = 0

  constructor(config?: TrackerConfig) {
    this.#totalWindow = config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    this.#outputReserve = config?.outputReserve ?? DEFAULT_OUTPUT_RESERVE
    this.#effectiveWindow = this.#totalWindow - this.#outputReserve
  }

  /** 更新窗口配置（切换模型时调用） */
  configure(config: TrackerConfig): void {
    if (config.contextWindow != null) {
      this.#totalWindow = config.contextWindow
    }
    if (config.outputReserve != null) {
      this.#outputReserve = config.outputReserve
    }
    this.#effectiveWindow = this.#totalWindow - this.#outputReserve
  }

  /** llm_done 事件后调用，更新精确 token 数 */
  update(inputTokens: number): void {
    this.#lastInputTokens = inputTokens
  }

  /** 获取当前状态快照 */
  getState(): ContextWindowState {
    const used = this.#lastInputTokens
    const remaining = Math.max(0, this.#effectiveWindow - used)
    const usedPercentage = this.#effectiveWindow > 0
      ? Math.min(1, used / this.#effectiveWindow)
      : 0

    let level: ContextLevel = 'normal'
    if (usedPercentage >= OVERFLOW_THRESHOLD) level = 'overflow'
    else if (usedPercentage >= CRITICAL_THRESHOLD) level = 'critical'
    else if (usedPercentage >= WARNING_THRESHOLD) level = 'warning'

    return {
      totalWindow: this.#totalWindow,
      outputReserve: this.#outputReserve,
      effectiveWindow: this.#effectiveWindow,
      lastInputTokens: used,
      usedPercentage,
      remaining,
      level,
    }
  }

  /** 重置（新会话时调用） */
  reset(): void {
    this.#lastInputTokens = 0
  }

  /** 是否应触发 auto-compact（>= 95%） */
  shouldAutoCompact(): boolean {
    return this.#effectiveWindow > 0 &&
      this.#lastInputTokens / this.#effectiveWindow >= OVERFLOW_THRESHOLD
  }
}

/** 全局单例 */
export const contextTracker = new ContextTrackerImpl()

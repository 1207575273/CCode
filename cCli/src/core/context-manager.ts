// src/core/context-manager.ts

/**
 * ContextManager — 上下文窗口管理中间层。
 *
 * 在 useChat 和 AgentLoop 之间拦截 history，执行裁剪和压缩。
 * 支持可插拔的 CompactStrategy（策略模式）。
 *
 * 架构分层：
 *   useChat（UI 状态） → ContextManager（裁剪/压缩） → AgentLoop（执行）
 */

import type { LLMProvider } from '@providers/provider.js'
import type { Message } from './types.js'
import { contextTracker } from './context-tracker.js'
import type { ContextWindowState, ContextLevel } from './context-tracker.js'
import type { ICompactBridge } from '@memory/core/compact-bridge.js'

// ═══════════════════════════════════════════════
// 策略接口
// ═══════════════════════════════════════════════

/** 压缩选项 */
export interface CompactOptions {
  model: string
  focus?: string
  systemPrompt?: string
}

/** 压缩结果 */
export interface CompactResult {
  history: Message[]
  summary: string
  tokensBefore: number
  compactedMessageCount: number
}

/** 可插拔的压缩策略接口 */
export interface CompactStrategy {
  readonly name: string
  readonly description: string
  compact(
    history: Message[],
    provider: LLMProvider,
    options: CompactOptions,
  ): Promise<CompactResult>
}

// ═══════════════════════════════════════════════
// 策略 A：全量替换（Claude Code 同款）
// ═══════════════════════════════════════════════

const COMPACT_SYSTEM_PROMPT = 'You are a conversation summarizer. Create a concise but comprehensive summary.'

const COMPACT_USER_PROMPT = `Summarize our conversation above. This summary will be the only context available when the conversation continues, so preserve critical information including:
- What was accomplished (completed work, created/modified files)
- Current work in progress (unfinished tasks, pending issues)
- Key files and code sections involved (file paths, function names)
- Next steps and planned actions
- Important user requests, constraints, or preferences
- Any errors encountered and how they were resolved

Be thorough but concise. Use structured markdown with headers.`

export class FullReplaceStrategy implements CompactStrategy {
  readonly name = 'full-replace'
  readonly description = 'Claude Code 同款：LLM 生成摘要完全替换历史'

  async compact(
    history: Message[],
    provider: LLMProvider,
    options: CompactOptions,
  ): Promise<CompactResult> {
    const tokensBefore = contextTracker.getState().lastInputTokens
    const compactedCount = history.length

    // 构建压缩请求：完整历史 + 压缩指令
    const compactMessages: Message[] = [
      ...history,
      {
        role: 'user',
        content: options.focus
          ? `${COMPACT_USER_PROMPT}\n\nFocus especially on: ${options.focus}`
          : COMPACT_USER_PROMPT,
      },
    ]

    // 调用 LLM 生成摘要
    let summary = ''
    for await (const chunk of provider.chat({
      model: options.model,
      messages: compactMessages,
      tools: [], // compact 不需要工具
      systemPrompt: COMPACT_SYSTEM_PROMPT,
    })) {
      if (chunk.type === 'text' && chunk.text) {
        summary += chunk.text
      }
    }

    if (!summary.trim()) {
      summary = '(compact failed: empty summary)'
    }

    // 全量替换：摘要作为唯一历史
    const compactedHistory: Message[] = [
      {
        role: 'user',
        content: `This is a summary of our previous conversation that was compacted to save context space:\n\n${summary}\n\nPlease continue from where we left off.`,
      },
    ]

    return {
      history: compactedHistory,
      summary,
      tokensBefore,
      compactedMessageCount: compactedCount,
    }
  }
}

// ═══════════════════════════════════════════════
// 策略 B：摘要 + 保留近期（Codex CLI 同款）
// ═══════════════════════════════════════════════

export class SummaryWithRecentStrategy implements CompactStrategy {
  readonly name = 'summary-with-recent'
  readonly description = 'Codex 同款：摘要 + 保留最近 N 条原始消息'

  /** 保留近期消息的估算 token 预算 */
  recentTokenBudget = 20_000

  async compact(
    history: Message[],
    provider: LLMProvider,
    options: CompactOptions,
  ): Promise<CompactResult> {
    const tokensBefore = contextTracker.getState().lastInputTokens

    // 估算保留多少条近期消息（~4 chars/token 粗估）
    let recentTokens = 0
    let splitIndex = history.length
    for (let i = history.length - 1; i >= 0; i--) {
      const content = history[i]!.content
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content)
      const msgTokens = Math.ceil(contentStr.length / 4)
      if (recentTokens + msgTokens > this.recentTokenBudget) break
      recentTokens += msgTokens
      splitIndex = i
    }
    // 至少保留最后 2 条
    splitIndex = Math.min(splitIndex, Math.max(0, history.length - 2))

    const olderHistory = history.slice(0, splitIndex)
    const recentHistory = history.slice(splitIndex)
    const compactedCount = olderHistory.length

    // 只对远期历史生成摘要
    let summary = ''
    if (olderHistory.length > 0) {
      const compactMessages: Message[] = [
        ...olderHistory,
        { role: 'user', content: COMPACT_USER_PROMPT },
      ]
      for await (const chunk of provider.chat({
        model: options.model,
        messages: compactMessages,
        tools: [],
        systemPrompt: COMPACT_SYSTEM_PROMPT,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          summary += chunk.text
        }
      }
    }

    const compactedHistory: Message[] = [
      ...(summary ? [{
        role: 'user' as const,
        content: `This is a summary of our earlier conversation:\n\n${summary}\n\nThe recent messages below are preserved verbatim.`,
      }] : []),
      ...recentHistory,
    ]

    return {
      history: compactedHistory,
      summary: summary || '(no older messages to summarize)',
      tokensBefore,
      compactedMessageCount: compactedCount,
    }
  }
}

// ═══════════════════════════════════════════════
// 策略 C：仅裁剪 Tool Results（零 LLM 成本）
// ═══════════════════════════════════════════════

/** tool 结果占位符 */
const TOOL_RESULT_PLACEHOLDER = '(tool output cleared to save context space — use the tool again if needed)'

export class ToolResultTrimStrategy implements CompactStrategy {
  readonly name = 'tool-trim'
  readonly description = '仅清理旧 tool 结果，不生成摘要（零 LLM 调用成本）'

  /** 保留最近 N 个 tool 结果 */
  keepRecentToolResults = 5

  async compact(
    history: Message[],
    _provider: LLMProvider,
    _options: CompactOptions,
  ): Promise<CompactResult> {
    const tokensBefore = contextTracker.getState().lastInputTokens
    const toolResultPattern = /^\[Tool \w+ result\]: /

    // 找到所有 tool result 消息的索引
    const toolResultIndices: number[] = []
    for (let i = 0; i < history.length; i++) {
      const c = history[i]!.content
      if (history[i]!.role === 'user' && typeof c === 'string' && toolResultPattern.test(c)) {
        toolResultIndices.push(i)
      }
    }

    // 保留最近 N 个，其余替换为占位符
    const trimSet = new Set(toolResultIndices.slice(0, -this.keepRecentToolResults))
    let compactedCount = 0

    const trimmedHistory = history.map((msg, i) => {
      if (trimSet.has(i)) {
        compactedCount++
        // 保留 tool 名称前缀，替换内容
        const msgContent = typeof msg.content === 'string' ? msg.content : ''
        const toolNameMatch = msgContent.match(/^\[Tool (\w+) result\]/)
        const toolName = toolNameMatch?.[1] ?? 'unknown'
        return { ...msg, content: `[Tool ${toolName} result]: ${TOOL_RESULT_PLACEHOLDER}` }
      }
      return msg
    })

    return {
      history: trimmedHistory,
      summary: `Trimmed ${compactedCount} old tool results, kept ${Math.min(this.keepRecentToolResults, toolResultIndices.length)} recent`,
      tokensBefore,
      compactedMessageCount: compactedCount,
    }
  }
}

// ═══════════════════════════════════════════════
// ContextManager
// ═══════════════════════════════════════════════

/** 内置策略注册表 */
const STRATEGIES = new Map<string, CompactStrategy>([
  ['full-replace', new FullReplaceStrategy()],
  ['summary-with-recent', new SummaryWithRecentStrategy()],
  ['tool-trim', new ToolResultTrimStrategy()],
])

/** 默认策略 */
const DEFAULT_STRATEGY = 'full-replace'

export class ContextManager {
  #strategyName: string = DEFAULT_STRATEGY
  #compactBridge: ICompactBridge | null = null

  /** 注入 CompactBridge（记忆系统启用时由 bootstrap 调用） */
  setCompactBridge(bridge: ICompactBridge): void {
    this.#compactBridge = bridge
  }

  /** 切换压缩策略 */
  setStrategy(name: string): boolean {
    if (!STRATEGIES.has(name)) return false
    this.#strategyName = name
    return true
  }

  /** 获取当前策略名称 */
  getStrategyName(): string {
    return this.#strategyName
  }

  /** 获取所有可用策略 */
  getAvailableStrategies(): Array<{ name: string; description: string }> {
    return [...STRATEGIES.values()].map(s => ({ name: s.name, description: s.description }))
  }

  /**
   * 准备 history — 在 AgentLoop.run() 之前调用。
   *
   * 1. 检查使用率是否需要 auto-compact
   * 2. 如果需要，执行策略级联（先 tool-trim，不够再 full compact）
   * 3. 返回优化后的 history
   */
  async prepare(
    rawHistory: Message[],
    provider: LLMProvider,
    options: CompactOptions,
  ): Promise<{ history: Message[]; compacted: boolean; result?: CompactResult }> {
    if (!contextTracker.shouldAutoCompact()) {
      return { history: rawHistory, compacted: false }
    }

    // 压缩前：通过 CompactBridge 提取关键信息到记忆系统（静默失败不影响压缩）
    if (this.#compactBridge) {
      try {
        await this.#compactBridge.extractAndSave(rawHistory, provider, options.model)
      } catch { /* 提取失败不阻塞压缩 */ }
    }

    // auto-compact 级联：先 tool-trim，不够再用主策略
    const toolTrim = STRATEGIES.get('tool-trim')!
    const trimResult = await toolTrim.compact(rawHistory, provider, options)

    // 粗估 trim 后的 token 数（原始 - 清理的 tool 结果估算）
    const estimatedSaved = trimResult.compactedMessageCount * 2000 // 每个 tool 结果平均 ~2000 tokens
    const currentTokens = contextTracker.getState().lastInputTokens
    const estimatedAfterTrim = currentTokens - estimatedSaved
    const effective = contextTracker.getState().effectiveWindow

    if (estimatedAfterTrim / effective < 0.70) {
      // tool-trim 足够，不需要 LLM 摘要
      return { history: trimResult.history, compacted: true, result: trimResult }
    }

    // tool-trim 不够，执行主策略（full-replace 或 summary-with-recent）
    const strategy = STRATEGIES.get(this.#strategyName) ?? STRATEGIES.get(DEFAULT_STRATEGY)!
    const result = await strategy.compact(rawHistory, provider, options)
    return { history: result.history, compacted: true, result }
  }

  /**
   * 手动 compact — /compact 命令调用。
   */
  async compact(
    rawHistory: Message[],
    provider: LLMProvider,
    options: CompactOptions & { strategy?: string },
  ): Promise<CompactResult> {
    // 压缩前：提取关键信息到记忆系统
    if (this.#compactBridge) {
      try {
        await this.#compactBridge.extractAndSave(rawHistory, provider, options.model)
      } catch { /* 提取失败不阻塞压缩 */ }
    }

    const strategyName = options.strategy ?? this.#strategyName
    const strategy = STRATEGIES.get(strategyName) ?? STRATEGIES.get(DEFAULT_STRATEGY)!
    const result = await strategy.compact(rawHistory, provider, options)

    // 压缩后：注入记忆提示
    if (this.#compactBridge) {
      const hint = this.#compactBridge.getCompactHint()
      if (hint && result.history.length > 0) {
        const lastMsg = result.history[result.history.length - 1]!
        if (typeof lastMsg.content === 'string') {
          result.history[result.history.length - 1] = {
            ...lastMsg,
            content: lastMsg.content + '\n\n' + hint,
          }
        }
      }
    }

    return result
  }
}

/** 全局单例 */
export const contextManager = new ContextManager()

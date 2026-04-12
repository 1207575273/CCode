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
import type { Message, MessageContent } from './types.js'
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

    // 【雷区一防御】调整 splitIndex 到完整工具调用轮次边界
    // 如果 splitIndex 恰好落在 assistant(tool_calls) 和 user(tool_results) 之间，
    // 必须向前移到 assistant 之前，确保不拆散成对关系。
    splitIndex = adjustToCompleteRound(history, splitIndex)

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

  /** 保留最近 N 个 tool 结果消息 */
  keepRecentToolResults = 5

  async compact(
    history: Message[],
    _provider: LLMProvider,
    _options: CompactOptions,
  ): Promise<CompactResult> {
    const tokensBefore = contextTracker.getState().lastInputTokens

    // 找到所有包含 tool_result 的消息索引（支持结构化格式 + 旧字符串格式兼容）
    const toolResultIndices: number[] = []
    for (let i = 0; i < history.length; i++) {
      if (isToolResultMessage(history[i]!)) {
        toolResultIndices.push(i)
      }
    }

    // 保留最近 N 个，其余替换内容为占位符
    const trimCount = Math.max(0, toolResultIndices.length - this.keepRecentToolResults)
    const trimSet = new Set(toolResultIndices.slice(0, trimCount))
    let compactedCount = 0

    const trimmedHistory = history.map((msg, i) => {
      if (!trimSet.has(i)) return msg
      compactedCount++
      return replaceToolResultContent(msg)
    })

    return {
      history: trimmedHistory,
      summary: `Trimmed ${compactedCount} old tool results, kept ${Math.min(this.keepRecentToolResults, toolResultIndices.length)} recent`,
      tokensBefore,
      compactedMessageCount: compactedCount,
    }
  }
}

/** 判断消息是否包含 tool_result（结构化格式 + 旧字符串格式兼容） */
function isToolResultMessage(msg: Message): boolean {
  // 结构化格式：content 为数组，包含 type:'tool_result' 的块
  if (Array.isArray(msg.content)) {
    return msg.content.some(b =>
      typeof b === 'object' && b !== null && (b as MessageContent).type === 'tool_result',
    )
  }
  // 旧字符串格式兼容（历史 JSONL 恢复场景）
  if (msg.role === 'user' && typeof msg.content === 'string') {
    return /^\[Tool \w+ result\]/.test(msg.content)
  }
  return false
}

/** 将 tool_result 消息的内容替换为占位符，保留 toolCallId 确保成对关系不断裂 */
function replaceToolResultContent(msg: Message): Message {
  if (Array.isArray(msg.content)) {
    const replaced = msg.content.map(b => {
      if (typeof b === 'object' && b !== null && (b as MessageContent).type === 'tool_result') {
        const tr = b as import('./types.js').ToolResultContent
        return { ...tr, result: TOOL_RESULT_PLACEHOLDER }
      }
      return b
    })
    return { ...msg, content: replaced }
  }
  // 旧字符串格式
  if (typeof msg.content === 'string') {
    const toolNameMatch = msg.content.match(/^\[Tool (\w+) result\]/)
    const toolName = toolNameMatch?.[1] ?? 'unknown'
    return { ...msg, content: `[Tool ${toolName} result]: ${TOOL_RESULT_PLACEHOLDER}` }
  }
  return msg
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

  /**
   * LLM 完整 history — 跨多次 AgentLoop.run() 持续累积的唯一 source of truth。
   *
   * 与 UI 的 ChatMessage[] 完全独立：
   * - ChatMessage 为渲染设计（纯文本 content + 独立 toolCall 对象）
   * - 此 history 为 LLM 设计（结构化 ToolCallContent / ToolResultContent）
   *
   * AgentLoop.run() 通过 getHistoryRef() 获取引用并直接追加消息，
   * run() 结束后无需额外同步——ContextManager 自动拥有完整 history。
   */
  #history: Message[] = []

  /** 获取内部 history 引用。AgentLoop.run() 直接在上面追加，零同步成本。 */
  getHistoryRef(): Message[] {
    return this.#history
  }

  /** 追加用户消息（useChat submit 时调用） */
  pushUser(content: string): void {
    this.#history.push({ role: 'user', content })
  }

  /** 追加结构化用户消息（含图片等多模态内容） */
  pushUserContent(content: MessageContent[]): void {
    this.#history.push({ role: 'user', content })
  }

  /**
   * 原地替换 history（compact 后调用）。
   * 用 length=0 + push 保持数组引用不变——如果 AgentLoop 正在持有引用不会断开。
   */
  replaceHistory(compacted: Message[]): void {
    this.#history.length = 0
    this.#history.push(...compacted)
  }

  /** /clear 时清空 */
  clearHistory(): void {
    this.#history.length = 0
  }

  /** /resume 从 JSONL 恢复结构化 history */
  restoreHistory(messages: Message[]): void {
    this.#history.length = 0
    this.#history.push(...messages)
  }

  /** 当前 history 消息条数 */
  get historyLength(): number { return this.#history.length }

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
      } catch {
        // 记忆提取失败不阻塞自动压缩，记忆为辅助功能
      }
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
      // tool-trim 足够，不需要 LLM 摘要 → 原地替换 #history
      this.replaceHistory(trimResult.history)
      return { history: this.#history, compacted: true, result: trimResult }
    }

    // tool-trim 不够，执行主策略（full-replace 或 summary-with-recent）
    const strategy = STRATEGIES.get(this.#strategyName) ?? STRATEGIES.get(DEFAULT_STRATEGY)!
    const result = await strategy.compact(rawHistory, provider, options)
    this.replaceHistory(result.history)
    return { history: this.#history, compacted: true, result }
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
      } catch {
        // 记忆提取失败不阻塞手动压缩，记忆为辅助功能
      }
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

/**
 * 调整切分点到完整工具调用轮次边界。
 *
 * 如果 splitIndex 落在 assistant(tool_calls) 和 user(tool_results) 之间，
 * 向前移到该 assistant 之前，确保不拆散成对关系。
 *
 * 【雷区一核心防御】：tool_call + tool_result 是不可分割的原子块。
 */
function adjustToCompleteRound(history: Message[], splitIndex: number): number {
  if (splitIndex <= 0 || splitIndex >= history.length) return splitIndex

  const msg = history[splitIndex]!

  // Case 1: splitIndex 指向一条 tool_result 消息 → 它的 assistant(tool_calls) 在前面，必须一起保留
  if (isToolResultMessage(msg)) {
    // 向前找到对应的 assistant(tool_calls)
    for (let i = splitIndex - 1; i >= 0; i--) {
      if (history[i]!.role === 'assistant' && hasToolCalls(history[i]!)) {
        return i // 切分点移到 assistant 之前
      }
      // 遇到非 tool_result 的 user 消息就停止回溯
      if (history[i]!.role === 'user' && !isToolResultMessage(history[i]!)) break
    }
  }

  // Case 2: splitIndex 指向一条 assistant(tool_calls) → 它后面的 tool_results 也要保留
  // 这种情况 splitIndex 已经在 assistant 上，后面的 tool_results 在 recent 中，是完整的
  // 不需要调整

  return splitIndex
}

/** 检查消息是否包含 tool_call 块 */
function hasToolCalls(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(b =>
    typeof b === 'object' && b !== null && (b as MessageContent).type === 'tool_call',
  )
}

/** 全局单例 */
export const contextManager = new ContextManager()

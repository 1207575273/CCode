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

import type { LLMProvider } from '@providers/provider.js'
import { summarizeArgs } from './args-summarizer.js'
import type { ToolRegistry } from '@tools/core/registry.js'
import type { ToolResult, ToolResultMeta } from '@tools/core/types.js'
import { isStreamableTool } from '@tools/core/types.js'
import type { Message, MessageContent, ToolCallContent, ToolResultContent, StreamChunk } from './types.js'
import { classifyToolCalls, executeSafeToolsInParallel } from './parallel-executor.js'
import type { HookManager } from '@hooks/hook-manager.js'
import { contextTracker } from './context-tracker.js'
import { RepetitionDetector } from './repetition-detector.js'
import { dbg } from '../debug.js'

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/** AskUserQuestion 工具 — 单个问题定义 */
export interface UserQuestion {
  /** 答案字段名，如 "domain", "focus" */
  key: string
  /** 问题标题 */
  title: string
  /** 问题类型 */
  type: 'select' | 'multiselect' | 'text'
  /** select/multiselect 时的选项列表 */
  options?: UserQuestionOption[]
  /** text 类型的输入提示 */
  placeholder?: string
}

export interface UserQuestionOption {
  label: string
  description?: string
}

/** AskUserQuestion 工具 — 用户回答结果 */
export interface UserQuestionResult {
  cancelled: boolean
  answers?: Record<string, string | string[]>
}

/**
 * AgentEvent — run() 的 yield 类型。
 *
 * 业务事件（UI 消费）：
 *   text / tool_start / tool_done / permission_request / user_question_request / error / done
 *
 * 观测事件（SessionLogger 消费，写入 JSONL）：
 *   llm_start / llm_done / llm_error / tool_fallback / permission_grant
 *
 * 子 Agent 事件（SubAgent 场景）：
 *   subagent_progress
 */
export type AgentEvent =
  // 业务事件
  | { type: 'text';               text: string }
  | { type: 'thinking';           text: string }
  | { type: 'tool_start';         toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done';          toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string; resultFull?: string; meta?: ToolResultMeta }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown>; resolve: (allow: boolean) => void }
  | { type: 'user_question_request'; questions: UserQuestion[]; resolve: (result: UserQuestionResult) => void }
  | { type: 'error';              error: string }
  | { type: 'done';               reason?: 'complete' | 'max_turns' | 'aborted' }
  // 观测事件
  | { type: 'llm_start';          provider: string; model: string; messageCount: number; systemPrompt?: string }
  | { type: 'llm_done';           inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; stopReason: string }
  | { type: 'llm_error';          error: string; partialOutputTokens?: number }
  | { type: 'tool_fallback';      toolName: string; fromLevel: string; toLevel: string; reason: string }
  | { type: 'post_tool_feedback'; toolName: string; toolCallId: string; feedback: string }
  | { type: 'permission_grant';   toolName: string; always: boolean }
  // 子 Agent 事件 — dispatch_agent 的 stream() 通过 yield* 透传到主 AgentLoop
  | { type: 'subagent_progress';  agentId: string; name: string; agentType: string; description: string; turn: number; maxTurns: number; currentTool?: string }
  | { type: 'subagent_done';      agentId: string; name: string; description: string; success: boolean; output: string }
  // 任务规划事件 — todo_write 工具执行后由 useChat 广播
  | { type: 'todo_update'; todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }> }

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
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 主 Agent 默认最大轮次 */
const DEFAULT_MAX_TURNS = 100

/** resultSummary 最大长度（CLI 展示用） */
const RESULT_SUMMARY_MAX_LENGTH = 200
/** resultFull 最大长度（Web 展示 + JSONL 持久化用，超过此长度截断） */
const RESULT_FULL_MAX_LENGTH = 100_000
/** 回传 LLM history 的工具结果最大字符数（兜底截断，防 bash/task_output 极端场景） */
const LLM_RESULT_MAX_CHARS = 40_000

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
  get provider(): LLMProvider { return this.#provider }

  /** 暴露 registry 给 StreamableTool（子 Agent 需要 cloneWithout） */
  get registry(): ToolRegistry { return this.#registry }

  /**
   * 主循环：LLM 调用 → [工具执行 → LLM 调用]* → 文本回复
   */
  async *run(messages: Message[]): AsyncIterable<AgentEvent> {
    // 直接引用传入数组（不复制）。ContextManager 通过 getHistoryRef() 传入，
    // run() 中追加的 assistant + tool_result 自动反映到 ContextManager 内部。
    const history = messages
    const maxTurns = this.#config.maxTurns ?? DEFAULT_MAX_TURNS
    const minToolRounds = this.#config.minTurns ?? 0
    /** 实际执行了工具的轮次数（不含纯文本轮） */
    let toolRounds = 0

    for (let turn = 0; turn < maxTurns; turn++) {
      const llmResult = yield* this.#callLLM(history)
      if (llmResult.aborted) return

      // 追加 assistant 消息到 history（text + tool_calls 摘要）
      // tool_call 只记录 id/name，不记录完整 args（args 可能包含 write_file 的整个文件内容，
      // 放入 history 会导致每轮 LLM 调用 token 数爆炸）
      const assistantContent: MessageContent[] = []
      if (llmResult.text) {
        assistantContent.push({ type: 'text', text: llmResult.text })
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
        history.push({ role: 'assistant', content: assistantContent })
      }

      if (llmResult.toolCalls.length === 0) {
        // 续跑检测：SubAgent 模式下，工具调用轮次不足 minToolRounds 时注入继续消息
        if (toolRounds < minToolRounds && this.#config.isSidechain) {
          history.push({
            role: 'user',
            content: 'You have not completed the task yet. Continue executing tools to finish the task. Do NOT just describe what to do — actually call tools.',
          })
          continue
        }
        yield { type: 'done', reason: 'complete' }
        return
      }

      toolRounds++
      yield* this.#executeToolCalls(llmResult.toolCalls, history)
    }

    // 超过最大轮次：以 done + max_turns 结束，不再 yield error（调用方可按 reason 区分）
    yield { type: 'done', reason: 'max_turns' }
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
  async *#callLLM(
    history: Message[],
  ): AsyncGenerator<AgentEvent, { toolCalls: ToolCallContent[]; text: string; aborted: boolean }> {
    const chatRequest = {
      model: this.#config.model,
      messages: history,
      tools: this.#registry.toToolDefinitions(),
      ...(this.#config.signal !== undefined ? { signal: this.#config.signal } : {}),
      ...(this.#config.systemPrompt !== undefined ? { systemPrompt: this.#config.systemPrompt } : {}),
    }

    yield {
      type: 'llm_start',
      provider: this.#config.provider,
      model: this.#config.model,
      messageCount: history.length,
      ...(this.#config.systemPrompt !== undefined ? { systemPrompt: this.#config.systemPrompt } : {}),
    }

    const pendingToolCalls: ToolCallContent[] = []
    let accumulatedText = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    // 从 done chunk 中取 stopReason，经 ProviderWrapper 标准化后直接使用
    let doneStopReason = 'end_turn'

    try {
      for await (const chunk of this.#provider.chat(chatRequest)) {
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
            return { toolCalls: [], text: '', aborted: true }
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

      yield { type: 'llm_done', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, stopReason: doneStopReason }
      // 更新上下文窗口追踪（精确值来自 API 返回的 inputTokens）
      if (inputTokens > 0) {
        contextTracker.update(inputTokens)
      }
      return { toolCalls: pendingToolCalls, text: accumulatedText, aborted: false }
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'llm_done', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, stopReason: 'abort' }
      } else {
        yield makeLlmError(err instanceof Error ? err.message : String(err), outputTokens)
      }
      throw err
    }
  }

  /** StreamChunk → AgentEvent 映射，null 表示不产生事件 */
  #mapChunk(chunk: StreamChunk, pendingToolCalls: ToolCallContent[]): AgentEvent | null {
    switch (chunk.type) {
      case 'text':     return chunk.text ? { type: 'text', text: chunk.text } : null
      case 'thinking': return { type: 'thinking', text: chunk.thinking ?? '' }
      case 'tool_call': { if (chunk.toolCall) pendingToolCalls.push(chunk.toolCall); return null }
      case 'error':    return { type: 'error', error: chunk.error ?? 'unknown error' }
      default:         return null // usage / done 不产生业务事件
    }
  }

  // ─────────────────────────────────────────────
  // 工具执行
  // ─────────────────────────────────────────────

  /**
   * 分发工具调用：parallelTools=false 时全部串行；否则安全工具并行、危险工具串行。
   */
  async *#executeToolCalls(toolCalls: ToolCallContent[], history: Message[]): AsyncGenerator<AgentEvent> {
    // parallelTools === false → 全部串行（兼容模式）
    if (this.#config.parallelTools === false) {
      for (const tc of toolCalls) {
        yield* this.#executeOneTool(tc, history)
      }
      return
    }

    // 分组：safe 并行，dangerous 串行
    const { safe, dangerous } = classifyToolCalls(toolCalls, this.#registry)

    if (safe.length + dangerous.length > 1) {
      process.stderr.write(`[parallel] ${toolCalls.length} tools → safe: ${safe.map(t => t.toolName).join(',')} | dangerous: ${dangerous.map(t => t.toolName).join(',')}\n`)
    }

    // 1. 并行执行安全工具
    if (safe.length > 0) {
      const events: AgentEvent[] = []
      const ctx = buildToolContext(this.#provider, this.#registry, this.#config, history)
      const results = await executeSafeToolsInParallel(
        safe, this.#registry, (e) => events.push(e), ctx, this.#config.maxParallelTools,
      )
      // yield 收集到的事件
      for (const e of events) { yield e }
      // 所有并行工具结果合并到一条 user 消息（Anthropic 要求同一条消息包含所有 tool_result）
      const toolResults: ToolResultContent[] = results.map(pr => {
        // 失败时合并 output + error（output 可能含 stderr 等诊断信息）
        const raw = pr.success
          ? pr.output
          : [pr.output, pr.error].filter(Boolean).join('\n') || 'error'
        return {
          type: 'tool_result' as const,
          toolCallId: pr.toolCallId,
          result: truncateForLLM(raw, pr.toolName),
          ...(pr.success === false ? { isError: true as const } : {}),
        }
      })
      if (toolResults.length > 0) {
        history.push({ role: 'user', content: toolResults })
      }
    }

    // 2. 串行执行危险工具
    for (const tc of dangerous) {
      yield* this.#executeOneTool(tc, history)
    }
  }

  /**
   * 执行单个工具调用。
   *
   * 普通工具：await tool.execute()
   * 流式工具（StreamableTool）：yield* tool.stream()，中间事件实时透传
   *
   * yield: tool_start → [permission_request → permission_grant] → [subagent_progress*] → tool_done
   */
  async *#executeOneTool(tc: ToolCallContent, history: Message[]): AsyncGenerator<AgentEvent> {
    yield { type: 'tool_start', toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.args }

    // ── 重复调用检测 ──
    // 在权限检查之前执行，因为 block 级别的拦截根本不需要走后续流程
    const verdict = this.#repetitionDetector.check(tc)
    if (verdict.action === 'block') {
      dbg(`[REPETITION-BLOCK] ${tc.toolName} × ${verdict.count}, skipping execution\n`)
      history.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: tc.toolCallId, result: verdict.message, isError: true }] })
      yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs: 0, success: false, resultSummary: `循环调用已拦截 (${tc.toolName} × ${verdict.count})` }
      return
    }

    // 权限检查：isSidechain 模式跳过弹窗（主 Agent 派发即授权）
    const allowed = yield* this.#checkPermission(tc)
    if (!allowed) {
      history.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: tc.toolCallId, result: 'rejected by user', isError: true }] })
      yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs: 0, success: false, resultSummary: 'rejected by user' }
      return
    }

    // PreToolUse Hook：检查是否被拦截或参数被修改
    let toolArgs = tc.args
    if (this.#config.hookManager) {
      const preResults = await this.#config.hookManager.run('PreToolUse', {
        trigger: tc.toolName,
        env: { CCODE_TOOL_NAME: tc.toolName, CCODE_TOOL_CALL_ID: tc.toolCallId },
        stdin: JSON.stringify({ toolName: tc.toolName, args: tc.args }),
      })
      for (const r of preResults) {
        if (!r) continue
        if (r['decision'] === 'block') {
          const reason = typeof r['reason'] === 'string' ? r['reason'] : 'blocked by hook'
          history.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: tc.toolCallId, result: `blocked: ${reason}`, isError: true }] })
          yield { type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId, durationMs: 0, success: false, resultSummary: reason }
          return
        }
        if (r['decision'] === 'modify' && typeof r['modifiedArgs'] === 'object' && r['modifiedArgs'] !== null) {
          toolArgs = r['modifiedArgs'] as Record<string, unknown>
        }
      }
    }

    // 构建 ToolContext（流式工具需要 provider/registry 来创建子 AgentLoop）
    const ctx = buildToolContext(this.#provider, this.#registry, this.#config, history)

    const start = Date.now()
    const tool = this.#registry.get(tc.toolName)

    // 【雷区一防御】工具执行必须 try/catch，确保任何异常都产生 tool_result，
    // 绝不能让 assistant 消息中的 tool_call 成为孤儿（无对应 tool_result）。
    // registry.execute() 内部已有 catch，但 StreamableTool 的 yield* 没有。
    let result: ToolResult
    try {
      if (tool && isStreamableTool(tool)) {
        // 流式工具（如 dispatch_agent）：yield* 透传中间事件，return 值为最终结果
        result = yield* (tool.stream(toolArgs, ctx) as AsyncGenerator<AgentEvent, ToolResult>)
      } else {
        // 普通工具：await execute()
        result = await this.#registry.execute(tc.toolName, toolArgs, ctx)
      }
    } catch (err) {
      // 【雷区二防御】异常的完整 stack 传回 LLM，让模型能定位错误并自我纠错
      const errDetail = err instanceof Error
        ? `${err.message}\n${err.stack ?? ''}`
        : String(err)
      result = { success: false, output: '', error: errDetail }
    }

    const durationMs = Date.now() - start

    // 失败时合并 output + error 传给 LLM（output 可能含 stderr 等诊断信息，不能丢）
    const toolResultRaw = result.success
      ? result.output
      : [result.output, result.error].filter(Boolean).join('\n') || 'error'
    // 兜底截断：防 bash/task_output 等工具返回超长结果膨胀 history
    const toolResultText = truncateForLLM(toolResultRaw, tc.toolName)

    history.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: tc.toolCallId,
        result: toolResultText,
        ...(result.success === false ? { isError: true } : {}),
      }],
    })

    // ── 重复调用 warn 级别：注入警告到 history，让 LLM 下一轮看到 ──
    if (verdict.action === 'warn') {
      const warning = this.#repetitionDetector.buildWarningMessage(verdict.toolName, verdict.count)
      dbg(`[REPETITION-WARN] ${tc.toolName} × ${verdict.count}\n`)
      history.push({ role: 'user', content: warning })
    }

    // PostToolUse Hook：工具执行后通知 + 消费反馈（Reflection 闭环）
    // 放在 history.push(工具结果) 之后，这样 LLM 先看到工具结果，再看到验证反馈。
    // hook 脚本可返回 { additionalContext: "tsc error: ..." }，追加到 history 引导 LLM 自行修正。
    if (this.#config.hookManager) {
      const postResults = await this.#config.hookManager.run('PostToolUse', {
        trigger: tc.toolName,
        env: { CCODE_TOOL_NAME: tc.toolName, CCODE_TOOL_CALL_ID: tc.toolCallId },
        stdin: JSON.stringify({ toolName: tc.toolName, result: { success: result.success, output: truncate(result.output, 1000) } }),
      })

      for (const r of postResults) {
        if (!r) continue
        const ctx = r['additionalContext']
        if (typeof ctx === 'string' && ctx.trim()) {
          history.push({ role: 'user', content: `[PostToolUse feedback for ${tc.toolName}]: ${ctx}` })
          // yield 事件让 SessionLogger 持久化到 JSONL
          yield { type: 'post_tool_feedback', toolName: tc.toolName, toolCallId: tc.toolCallId, feedback: ctx }
        }
      }
    }

    const rawOutput = result.success ? result.output : (result.error ?? 'error')
    const resultSummary = truncate(rawOutput, RESULT_SUMMARY_MAX_LENGTH)
    const resultFull = truncate(rawOutput, RESULT_FULL_MAX_LENGTH)

    yield {
      type: 'tool_done', toolName: tc.toolName, toolCallId: tc.toolCallId,
      durationMs, success: result.success, resultSummary, resultFull,
      ...(result.meta !== undefined ? { meta: result.meta } : {}),
    }
  }

  /** 安全工具直接放行；危险工具 yield permission_request 暂停等待用户确认 */
  async *#checkPermission(tc: ToolCallContent): AsyncGenerator<AgentEvent, boolean> {
    // isSidechain 模式：子 Agent 内所有工具自动批准（主 Agent 派发即授权）
    if (this.#config.isSidechain) return true

    if (!this.#registry.isDangerous(tc.toolName)) return true

    let resolvePermission!: (v: boolean) => void
    const promise = new Promise<boolean>(r => { resolvePermission = r })
    yield { type: 'permission_request', toolName: tc.toolName, args: tc.args, resolve: resolvePermission }
    const allowed = await promise

    if (allowed) {
      yield { type: 'permission_grant', toolName: tc.toolName, always: false }
    }
    return allowed
  }
}

// ═══════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return maxLength >= 10000
    ? text.slice(0, maxLength) + `\n... (truncated, total ${text.length} chars)`
    : text.slice(0, maxLength) + '...'
}

/** 工具专属的截断后引导提示 */
const TRUNCATION_HINTS: Record<string, string> = {
  bash: '请用 grep/head/tail 过滤输出，或拆分为更小的命令',
  task_output: '输出过长，请用 bash 配合 grep/tail 过滤关键信息',
  grep: '请缩小 pattern 范围或指定更精确的搜索路径',
  read_file: '请指定行号范围读取特定区域',
}

/**
 * 截断工具结果后塞入 LLM history（兜底层）。
 * 大部分工具内部已有截断（read_file 20K / grep 50 条），此处防 bash/task_output 极端场景。
 */
function truncateForLLM(output: string, toolName: string): string {
  if (output.length <= LLM_RESULT_MAX_CHARS) return output
  const hint = TRUNCATION_HINTS[toolName] ?? '结果过长已截断，请尝试缩小查询范围'
  return output.slice(0, LLM_RESULT_MAX_CHARS) +
    `\n\n[结果已截断：共 ${output.length} 字符，仅保留前 ${LLM_RESULT_MAX_CHARS} 字符。${hint}]`
}

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
    ? { type: 'llm_error', error, partialOutputTokens: partialTokens }
    : { type: 'llm_error', error }
}

/** 构建 ToolContext，兼容 exactOptionalPropertyTypes（不传 undefined 值） */
function buildToolContext(provider: LLMProvider, registry: ToolRegistry, config: AgentConfig, history?: ReadonlyArray<Message>): import('@tools/core/types.js').ToolContext {
  const ctx: import('@tools/core/types.js').ToolContext = {
    cwd: process.cwd(),
    provider,
    providerName: config.provider,
    model: config.model,
    registry,
  }
  if (config.signal !== undefined) { ctx.signal = config.signal }
  if (config.sessionId !== undefined) { ctx.sessionId = config.sessionId }
  if (config.nonInteractive) { ctx.nonInteractive = config.nonInteractive }
  if (config.systemPrompt !== undefined) { ctx.systemPrompt = config.systemPrompt }
  if (config.config !== undefined) { ctx.config = config.config }
  if (history !== undefined) { ctx.history = history }
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

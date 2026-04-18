// src/tools/agent/dispatch-agent.ts

/**
 * DispatchAgentTool — 派发子 Agent 执行独立任务。
 *
 * 实现 StreamableTool 接口：
 * - stream(): yield 子 Agent 进度事件，return 最终结果
 * - execute(): fallback，消费 stream() 但丢弃中间事件
 *
 * 子 Agent 拥有完整的 AgentLoop（多轮 LLM + 工具调用），
 * 通过 AgentDefinitionRegistry 按 subagent_type 获取类型配置：
 * - 系统提示词
 * - 工具白名单/黑名单
 * - 最大轮次
 *
 * 所有子 Agent 硬编码排除 dispatch_agent（禁止递归）和 ask_user_question。
 *
 * 输出为结构化 JSON（AgentOutput），区分 completed / async_launched / error。
 */

import type { ToolContext, ToolResult, StreamableTool } from '../core/types.js'
import type { ToolRegistry } from '../core/registry.js'
import { AgentLoop } from '@core/agent-loop.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { isAbortError } from '@core/agent-loop.js'
import { sessionStore } from '@persistence/index.js'
import { SessionLogger } from '@observability/session-logger.js'
import { configManager } from '@config/config-manager.js'
import { getOrCreateProvider } from '@providers/registry.js'
import {
  registerSubAgent, consumeAgentEvent, markSubAgentDone,
  setSubAgentSessionId, resolveAgentName,
  setSubAgentControl, clearSubAgentControl, getSubAgent, buildStopReport, stopAgent,
} from './store.js'
import { getTodos } from '../ext/todo-store.js'
import { agentDefinitionRegistry } from './definition-registry.js'
import type { ToolPolicy, AgentCompletedOutput, AgentAsyncLaunchedOutput, AgentErrorOutput, AgentStoppedOutput } from './types.js'
import { trimHistoryForSubAgent } from './context-utils.js'
import { eventBus } from '@core/event-bus.js'

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 硬编码排除 — 所有子 Agent 类型必须遵守，不可通过 toolPolicy 覆盖 */
const ALWAYS_EXCLUDE = ['dispatch_agent', 'ask_user_question', 'control_agent']

/** SubAgent 默认 maxTurns（未匹配到定义时的兜底） */
const DEFAULT_MAX_TURNS = 50

// ═══════════════════════════════════════════════
// DispatchAgentTool
// ═══════════════════════════════════════════════

export class DispatchAgentTool implements StreamableTool {
  readonly name = 'dispatch_agent'

  get description(): string {
    const typeList = agentDefinitionRegistry.buildTypeDescriptions()
    return [
      '派发子 Agent 独立执行任务。子 Agent 拥有完整的多轮对话和工具调用能力。',
      '',
      '可用类型：',
      typeList,
      '',
      '重要：如何选择 run_in_background',
      '',
      '[必须 run_in_background=true] 当任务是"独立闭环交付"——你不需要子 Agent 的产出来做后续推理，',
      '子 Agent 跑完就是跑完。典型场景：',
      '• 搭建/初始化一个完整项目（新建后端服务、脚手架、目录结构）',
      '• 长时间构建/安装/部署（npm install、docker build、编译大型项目）',
      '• 独立的修复/重构任务（修一个完整 bug、完成一个完整 feature）',
      '• 用户直接下发的"帮我做 X"类任务（做完即交付，不需要主 Agent 继续串联）',
      '这类任务同步等待会让主 Agent 空转几十秒到几分钟，浪费时间和 token。',
      '',
      '[保持 run_in_background=false（默认）] 当你需要子 Agent 的结果继续推理：',
      '• 搜索代码/分析目录后，你要基于结果决定下一步（如"搜完认证逻辑→修 bug"）',
      '• 生成方案/调研/回答子问题，你要基于返回的文本继续组织回复',
      '• 子 Agent 的输出会喂给主 Agent 的下一轮推理',
      '',
      '判断诀窍：问自己"子 Agent 返回后，我还需要基于它的返回做什么吗？"',
      '  • 答"不需要，就是完成了" → run_in_background=true',
      '  • 答"需要，我还要根据结果继续推理/回答" → run_in_background=false',
      '',
      '其他注意事项：',
      '• 子 Agent 的结果已经过验证，不要重复验证或重新执行子 Agent 已完成的命令',
      '• 直接将子 Agent 的结果转述给用户即可',
      '• run_in_background=true 时立即返回 agentId，用 task_output 读取后续结果',
      '• 多个独立任务可以同时派发多个子 Agent 并行执行',
    ].join('\n')
  }

  get parameters() {
    return {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string' as const,
          description: '任务简述（3-5 个词，如"搜索认证逻辑"、"分析目录结构"）',
        },
        prompt: {
          type: 'string' as const,
          description: '给子 Agent 的完整指令（需包含足够上下文，子 Agent 看不到父对话历史）',
        },
        subagent_type: {
          type: 'string' as const,
          enum: agentDefinitionRegistry.getTypeNames(),
          description:
            'Agent 类型，决定可用工具和行为模式：\n' +
            agentDefinitionRegistry.buildTypeDescriptions(),
        },
        name: {
          type: 'string' as const,
          description: '子 Agent 名称（如 "search-auth"、"plan-refactor"），用于日志和进度追踪，不传则自动生成',
        },
        model: {
          type: 'string' as const,
          description: '指定模型（如 "glm-5"），不传则继承父 Agent 当前模型',
        },
        run_in_background: {
          type: 'boolean' as const,
          description:
            '后台执行。true 时立即返回 agentId（不阻塞主 Agent），用 task_output 读取结果。\n' +
            '独立闭环任务（搭项目、长构建、完整交付类任务）务必设为 true，避免主 Agent 空转等待。\n' +
            '需要基于子 Agent 返回结果做后续推理时保持 false（默认）。',
        },
      },
      required: ['description', 'prompt'] as const,
    }
  }

  /** dispatch_agent 本身不危险；子 Agent 内部的工具因 isSidechain 自动批准 */
  readonly dangerous = false

  /** fallback 执行：消费 stream() 但丢弃中间事件 */
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gen = this.stream(args, ctx)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    return next.value
  }

  /**
   * 流式执行。
   *
   * 事件三写：
   *   1. yield → 主 AgentLoop generator 链路
   *   2. subLogger.consume() → 子 Agent 独立 JSONL
   *   3. subagent-store → 内存缓存
   */
  async *stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<AgentEvent, ToolResult> {
    const description = String(args['description'] ?? '')
    const prompt = String(args['prompt'] ?? '')
    const runInBackground = args['run_in_background'] === true
    const subagentType = String(args['subagent_type'] ?? 'general')

    // 参数校验
    if (!prompt.trim()) {
      return { success: false, output: '', error: 'prompt 不能为空' }
    }
    if (!ctx.provider || !ctx.registry) {
      return { success: false, output: '', error: 'dispatch_agent 需要 ToolContext 中的 provider 和 registry' }
    }

    // 查找 Agent 定义（找不到回退 general）
    let definition = agentDefinitionRegistry.get(subagentType)
    if (!definition) {
      console.warn(`[dispatch_agent] 未知 subagent_type "${subagentType}"，回退到 general`)
      definition = agentDefinitionRegistry.get('general')!
    }

    const agentId = generateAgentId()
    const agentName = resolveAgentName(args['name'] as string | undefined, definition.agentType, agentId)
    const agentType = definition.agentType
    const maxTurns = definition.maxTurns || DEFAULT_MAX_TURNS

    // 解析 model
    const { provider: subProvider, providerName, modelName } = resolveSubAgentProvider(
      args['model'] as string | undefined, ctx,
    )

    // 创建独立 JSONL
    const subLogger = createSubagentLogger(agentId, ctx.cwd, providerName, modelName, ctx.sessionId)

    // 注册到内存 store
    registerSubAgent({ agentId, name: agentName, description, agentType, modelName, maxTurns })
    if (subLogger.sessionId) {
      setSubAgentSessionId(agentId, subLogger.sessionId)
    }

    // 派生宣告事件 — 让 UI 在 running 期间就能把 dispatch_agent 工具调用和子 Agent 卡片绑定
    // 必须携带 parentToolCallId（从 ctx 读取），前端通过它回补对应 ToolEvent 的 agentId
    if (ctx.toolCallId) {
      yield {
        type: 'subagent_spawn',
        parentToolCallId: ctx.toolCallId,
        agentId,
        name: agentName,
        agentType,
        description,
        maxTurns,
      }
    }

    // 构建受限工具集
    const subRegistry = buildSubRegistry(ctx.registry, definition.toolPolicy)

    // 为子 Agent 创建独立的会话级 Provider（隔离 ChatOpenAI 等有状态资源）
    const sessionProvider = subProvider.createSession?.() ?? subProvider

    // 子 Agent 使用自己的 systemPrompt（不继承主 Agent 的 Instructions/Skills/Hooks）
    // 主 Agent 的 systemPrompt 是给主 Agent 看的，对子 Agent 是噪音，会稀释指令权重
    // 上下文共享通过 ctx.history 传递（历史消息中已包含足够背景）
    const subSystemPrompt = definition.getSystemPrompt()

    // 每个 SubAgent 独立 AbortController（避免共享父 signal 导致 MaxListeners 泄漏）
    const subController = new AbortController()
    // SubAgent 的 LLM 多轮调用会给 signal 反复加 listener（LangChain stream 内部行为），
    // 默认 MaxListeners=10 不够用（25 轮 maxTurns），提高上限避免 Node.js 警告
    import('node:events').then(events => events.setMaxListeners(100, subController.signal)).catch(() => {})
    // 父 signal abort 时：
    // 1. 传播到子 Agent 的 AbortController（中断 LLM 流）
    // 2. 立即同步写入 session_end（防止进程退出时 fire-and-forget Promise 被丢弃）
    const onParentAbort = () => {
      subController.abort()
      // 防御性写入：如果后台 Promise 还没来得及 finalize 就被进程丢弃
      if (runInBackground) {
        const state = getSubAgent(agentId)
        if (state && state.status !== 'done' && state.status !== 'error' && state.status !== 'stopped') {
          subLogger.finalize('error')
          markSubAgentDone(agentId, '', 'error')
        }
      }
    }
    ctx.signal?.addEventListener('abort', onParentAbort, { once: true })

    // 创建子 AgentLoop
    const subLoop = new AgentLoop(sessionProvider, subRegistry, {
      model: modelName,
      provider: providerName,
      signal: subController.signal,
      maxTurns,
      isSidechain: true,
      isBackground: runInBackground,
      agentId,
      systemPrompt: subSystemPrompt,
      // 后台模式不传 minTurns — 已通过 isBackground 禁用续跑
      ...(!runInBackground && definition.minTurns !== undefined ? { minTurns: definition.minTurns } : {}),
    })

    // 🆕 注册控制句柄到 store（外部才能通过 stopAgent() 停止此子 Agent）
    setSubAgentControl(agentId, { abortController: subController, loop: subLoop })

    // 🆕 超时自动 stop（definition.timeoutMs 配置时生效）
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const effectiveTimeoutMs = definition.timeoutMs || (runInBackground ? 10 * 60 * 1000 : 0)
    if (effectiveTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const s = getSubAgent(agentId)
        if (s && s.status === 'running') {
          stopAgent(agentId, 'timeout', `执行超时 ${effectiveTimeoutMs / 1000}s`)
        }
        // 后台模式额外保护：stopAgent 后 5 秒仍未退出（LLM 无响应），
        // 直接 abort 强制中断 for-await 循环，确保 session_end 写入
        if (runInBackground) {
          setTimeout(() => {
            if (!subController.signal.aborted) {
              subController.abort()
            }
          }, 5_000).unref()
        }
      }, effectiveTimeoutMs)
    }

    subLogger.logUserMessage(prompt)

    // 构建子 Agent 初始消息：裁剪后的主 Agent 历史 + todo 上下文 + prompt
    const contextMessages = trimHistoryForSubAgent(ctx.history ?? [], definition.contextPolicy)

    // 注入主 Agent 的 todo 任务规划（如果有），让 SubAgent 了解全局任务分工
    const todoContext = buildTodoContext()

    // 在 prompt 末尾追加任务边界约束，防止子 Agent 自我扩展范围
    // 放在末尾是因为 LLM 对尾部指令的遵从度更高（recency bias）
    const scopeFence = '\n\n---\nIMPORTANT: Stay strictly within the scope described above. Do not expand, refactor, or fix anything beyond this task.'
    const fencedPrompt = prompt + scopeFence

    const initialMessages = [
      ...contextMessages,
      { role: 'user' as const, content: todoContext ? `${todoContext}\n\n${fencedPrompt}` : fencedPrompt },
    ]

    // ── 后台模式 ──
    if (runInBackground) {
      runSubAgentInBackground({
        subLoop, initialMessages, agentId, agentName, agentType,
        description, subLogger, modelName, maxTurns,
        parentSignal: ctx.signal, sessionProvider,
        cleanup: () => ctx.signal?.removeEventListener('abort', onParentAbort),
        ...(timeoutTimer ? { timeoutTimer } : {}),
      })

      yield {
        type: 'subagent_progress',
        agentId,
        name: agentName,
        agentType,
        description,
        turn: 0,
        maxTurns,
      } satisfies AgentEvent

      const output: AgentAsyncLaunchedOutput = {
        status: 'async_launched',
        agentId,
        name: agentName,
        agentType,
        model: modelName,
        prompt,
        description,
      }
      return { success: true, output: JSON.stringify(output), meta: { type: 'dispatch-agent', agentId, agentName, agentType, status: 'async_launched' } }
    }

    // ── 前台模式 ──
    let finalText = ''
    let currentTurn = 0
    let wasStoppedByCheckpoint = false

    try {
      for await (const event of subLoop.run(initialMessages)) {
        subLogger.consume(event)
        consumeAgentEvent(agentId, event)

        switch (event.type) {
          case 'text':
            finalText += event.text
            eventBus.emit({ type: 'subagent_event', agentId, detail: { kind: 'text', text: event.text } })
            break

          case 'tool_start':
            yield {
              type: 'subagent_progress',
              agentId, name: agentName, agentType, description,
              turn: currentTurn, maxTurns,
              currentTool: event.toolName,
            } satisfies AgentEvent
            eventBus.emit({
              type: 'subagent_event', agentId,
              detail: { kind: 'tool_start', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
            })
            break

          case 'tool_done':
            yield {
              type: 'subagent_progress',
              agentId, name: agentName, agentType, description,
              turn: currentTurn, maxTurns,
            } satisfies AgentEvent
            eventBus.emit({
              type: 'subagent_event', agentId,
              detail: { kind: 'tool_done', toolName: event.toolName, toolCallId: event.toolCallId, durationMs: event.durationMs, success: event.success, ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}) },
            })
            break

          case 'llm_start':
            currentTurn++
            yield {
              type: 'subagent_progress',
              agentId, name: agentName, agentType, description,
              turn: currentTurn, maxTurns,
            } satisfies AgentEvent
            break

          case 'llm_done':
            yield event
            break

          case 'error':
            eventBus.emit({ type: 'subagent_event', agentId, detail: { kind: 'error', error: event.error } })
            break

          case 'done':
            // reason='stopped' 表示 AgentLoop 因 requestStop 退出
            // reason='complete'/'max_turns' 表示 AgentLoop 自然完成（stop 可能是时序竞争）
            if (event.reason === 'stopped') wasStoppedByCheckpoint = true
            break

          default:
            break
        }
      }

      // 循环退出 — 区分"正常完成" vs "优雅停止"
      const state = getSubAgent(agentId)
      if (wasStoppedByCheckpoint && state?.stopRequest) {
        // 优雅停止：AgentLoop 因 requestStop 在检查点退出
        const report = buildStopReport(state, finalText, currentTurn, 'graceful')
        state.stopReport = report
        subLogger.logLifecycle('stopped', {
          resolution: 'graceful',
          source: state.stopRequest.source,
          reason: state.stopRequest.reason,
          turn: currentTurn, maxTurns,
        })
        subLogger.logAssistantMessage(finalText || '(stopped)', modelName)
        subLogger.finalize('stopped')
        markSubAgentDone(agentId, finalText, 'stopped')

        const output: AgentStoppedOutput = {
          status: 'stopped',
          agentId, name: agentName, agentType,
          resolution: 'graceful',
          source: report.source,
          reason: report.reason,
          turn: currentTurn, maxTurns,
          partialResult: finalText,
          ...(report.tokenUsed ? { tokenUsed: report.tokenUsed } : {}),
          guidance: buildStopGuidance(report.source, 'graceful'),
        }
        return { success: true, output: JSON.stringify(output), meta: { type: 'dispatch-agent', agentId, agentName, agentType, status: 'stopped' } }
      }

      // 正常完成
      subLogger.logAssistantMessage(finalText || '(no text output)', modelName)
      subLogger.finalize('done')
      markSubAgentDone(agentId, finalText, 'done')

      const output: AgentCompletedOutput = {
        status: 'completed',
        agentId,
        name: agentName,
        agentType,
        model: modelName,
        prompt,
        result: finalText,
      }
      return { success: true, output: JSON.stringify(output), meta: { type: 'dispatch-agent', agentId, agentName, agentType, status: 'completed' } }

    } catch (err) {
      const state = getSubAgent(agentId)

      // 区分 abort 来源：宽限期超时 vs 父 Agent Ctrl+C
      if (isAbortError(err) && state?.stopRequest) {
        const fromParentAbort = ctx.signal?.aborted === true
        if (!fromParentAbort) {
          // 宽限期超时强制中断
          const report = buildStopReport(state, finalText, currentTurn, 'forced')
          state.stopReport = report
          subLogger.logLifecycle('stopped', {
            resolution: 'forced',
            source: state.stopRequest.source,
            reason: state.stopRequest.reason,
            turn: currentTurn, maxTurns,
          })
          if (finalText) {
            subLogger.logAssistantMessage(finalText, modelName)
          }
          subLogger.finalize('stopped')
          markSubAgentDone(agentId, finalText, 'stopped')

          const output: AgentStoppedOutput = {
            status: 'stopped',
            agentId, name: agentName, agentType,
            resolution: 'forced',
            source: report.source,
            reason: report.reason,
            turn: currentTurn, maxTurns,
            partialResult: finalText,
            ...(report.tokenUsed ? { tokenUsed: report.tokenUsed } : {}),
            guidance: buildStopGuidance(report.source, 'forced'),
          }
          return { success: true, output: JSON.stringify(output), meta: { type: 'dispatch-agent', agentId, agentName, agentType, status: 'stopped' } }
        }
      }

      // 常规异常
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (finalText) {
        subLogger.logAssistantMessage(finalText, modelName)
      }
      subLogger.finalize('error')
      markSubAgentDone(agentId, finalText, 'error')

      const output: AgentErrorOutput = {
        status: 'error',
        agentId,
        name: agentName,
        agentType,
        error: errorMsg,
        ...(finalText ? { partialResult: finalText } : {}),
      }
      return {
        success: false,
        output: JSON.stringify(output),
        error: `子 Agent 执行异常: ${errorMsg}`,
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      clearSubAgentControl(agentId)
      ctx.signal?.removeEventListener('abort', onParentAbort)
      sessionProvider.dispose?.()
    }
  }
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

/**
 * 为 StopReport 生成给主 Agent 看的自然语言行为指引。
 *
 * 背景：主 Agent 收到子 Agent 的 stop 结果时，仅凭 `source` 枚举值
 * （user_web / user_cli / timeout / parent_agent）不足以让 LLM 判断后续动作，
 * 实测 LLM 会把 user 主动停止误解为"子 Agent 失败"而自己代替执行，违背用户意图。
 * 这里用明确的自然语言告知 LLM 该做什么、不该做什么。
 *
 * 导出供单元测试使用（见 tests/unit/dispatch-agent-stop-guidance.test.ts）。
 */
export function buildStopGuidance(
  source: import('./store.js').StopSource,
  resolution: 'graceful' | 'forced',
): string {
  switch (source) {
    case 'user_web':
    case 'user_cli': {
      const channel = source === 'user_web' ? 'Web 端' : 'CLI 端'
      return [
        `⚠️ 用户在 ${channel} 主动停止了此子 Agent（resolution=${resolution}）。`,
        '这表示用户对任务的方向或执行方式有新想法，**不是执行失败**。',
        '',
        '你**禁止**：',
        '1. 自己代替子 Agent 执行该任务（例如直接调用工具继续完成）。',
        '2. 立刻重新派发同一个子 Agent 去做相同或相似的事。',
        '3. 假设用户只是"暂停"，然后自作主张接着干。',
        '',
        '你**必须**：',
        '直接用自然语言向用户回复，简要告诉用户：',
        '  (1) 子 Agent 已在第几轮被停止、已产出什么（如有 partialResult）；',
        '  (2) 询问用户接下来希望：',
        '      · 放弃该任务？',
        '      · 换一种方式继续（请说明新的方向）？',
        '      · 还是有别的指示？',
        '在用户给出明确回复前，**不要开始任何新操作**（不要调用工具）。',
      ].join('\n')
    }
    case 'timeout':
      return [
        `⚠️ 子 Agent 因超时被${resolution === 'forced' ? '强制' : '优雅'}停止。`,
        '请根据 partialResult 判断任务是否已完成足够的部分：',
        '- 若已完成关键部分，可总结已完成工作并询问用户是否继续。',
        '- 若进度很少，考虑调整策略（增加 timeoutMs、拆分任务）后再次派发。',
      ].join('\n')
    case 'parent_agent':
      return '你之前主动停止了该子 Agent，请根据当前任务上下文继续你的主流程。'
    default:
      return `子 Agent 被停止（source=${source}, resolution=${resolution}），请根据 partialResult 决定下一步。`
  }
}

/** 构建受限 ToolRegistry */
function buildSubRegistry(parentRegistry: ToolRegistry, toolPolicy: ToolPolicy): ToolRegistry {
  if (toolPolicy.mode === 'include') {
    const allowed = toolPolicy.tools.filter(t => !ALWAYS_EXCLUDE.includes(t))
    return parentRegistry.cloneWith(...allowed)
  } else {
    const allExclude = [...new Set([...ALWAYS_EXCLUDE, ...toolPolicy.tools])]
    return parentRegistry.cloneWithout(...allExclude)
  }
}

/** 后台执行参数 */
interface BackgroundRunOptions {
  subLoop: AgentLoop
  initialMessages: import('@core/types.js').Message[]
  agentId: string
  agentName: string
  agentType: string
  description: string
  subLogger: SessionLogger
  modelName: string
  maxTurns: number
  parentSignal: AbortSignal | undefined
  sessionProvider?: import('@providers/provider.js').LLMProvider
  cleanup?: () => void
  timeoutTimer?: ReturnType<typeof setTimeout>
}

/**
 * 后台执行子 AgentLoop（fire-and-forget）。
 * 事件双写到 store + JSONL，通过 eventBus 广播进度。
 * 支持优雅停止 + 宽限期强制中断，区分 Ctrl+C 与 stop。
 */
function runSubAgentInBackground(opts: BackgroundRunOptions): void {
  const {
    subLoop, initialMessages, agentId, agentName, agentType,
    description, subLogger, modelName, maxTurns, parentSignal,
    sessionProvider, cleanup, timeoutTimer,
  } = opts
  let finalText = ''
  let currentTurn = 0
  let wasStoppedByCheckpoint = false

  void (async () => {
    try {
      for await (const event of subLoop.run(initialMessages)) {
        subLogger.consume(event)
        consumeAgentEvent(agentId, event)

        switch (event.type) {
          case 'text':
            finalText += event.text
            eventBus.emit({ type: 'subagent_event', agentId, detail: { kind: 'text', text: event.text } })
            break

          case 'llm_start':
            currentTurn++
            eventBus.emit({
              type: 'subagent_progress',
              agentId, name: agentName, agentType, description,
              turn: currentTurn, maxTurns,
            })
            break

          case 'tool_start':
            eventBus.emit({
              type: 'subagent_progress',
              agentId, name: agentName, agentType, description,
              turn: currentTurn, maxTurns,
              currentTool: event.toolName,
            })
            eventBus.emit({
              type: 'subagent_event', agentId,
              detail: { kind: 'tool_start', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
            })
            break

          case 'tool_done':
            eventBus.emit({
              type: 'subagent_progress',
              agentId, name: agentName, agentType, description,
              turn: currentTurn, maxTurns,
            })
            eventBus.emit({
              type: 'subagent_event', agentId,
              detail: { kind: 'tool_done', toolName: event.toolName, toolCallId: event.toolCallId, durationMs: event.durationMs, success: event.success, ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}) },
            })
            break

          case 'error':
            eventBus.emit({ type: 'subagent_event', agentId, detail: { kind: 'error', error: event.error } })
            break

          case 'done':
            if (event.reason === 'stopped') wasStoppedByCheckpoint = true
            break

          default:
            break
        }
      }

      // 循环退出 — 区分"正常完成" vs "优雅停止"
      const state = getSubAgent(agentId)
      if (wasStoppedByCheckpoint && state?.stopRequest) {
        const report = buildStopReport(state, finalText, currentTurn, 'graceful')
        state.stopReport = report
        subLogger.logLifecycle('stopped', {
          resolution: 'graceful',
          source: state.stopRequest.source,
          reason: state.stopRequest.reason,
          turn: currentTurn, maxTurns,
        })
        subLogger.logAssistantMessage(finalText || '(stopped)', modelName)
        subLogger.finalize('stopped')
        markSubAgentDone(agentId, finalText, 'stopped')

        eventBus.emit({
          type: 'subagent_done',
          agentId, name: agentName, description,
          success: true,
          output: JSON.stringify({
            status: 'stopped',
            ...report,
            guidance: buildStopGuidance(report.source, 'graceful'),
          }),
        })
        return
      }

      // 正常完成
      subLogger.logAssistantMessage(finalText || '(no text output)', modelName)
      subLogger.finalize('done')
      markSubAgentDone(agentId, finalText, 'done')

      eventBus.emit({
        type: 'subagent_done',
        agentId,
        name: agentName,
        description,
        success: true,
        output: finalText,
      })
    } catch (err) {
      const state = getSubAgent(agentId)

      // 区分 abort 来源：宽限期超时 vs 父 Agent Ctrl+C
      if (isAbortError(err) && state?.stopRequest) {
        const fromParentAbort = parentSignal?.aborted === true
        if (!fromParentAbort) {
          // 宽限期超时强制中断
          const report = buildStopReport(state, finalText, currentTurn, 'forced')
          state.stopReport = report
          subLogger.logLifecycle('stopped', {
            resolution: 'forced',
            source: state.stopRequest.source,
            reason: state.stopRequest.reason,
            turn: currentTurn, maxTurns,
          })
          if (finalText) {
            subLogger.logAssistantMessage(finalText, modelName)
          }
          subLogger.finalize('stopped')
          markSubAgentDone(agentId, finalText, 'stopped')

          eventBus.emit({
            type: 'subagent_done',
            agentId, name: agentName, description,
            success: true,
            output: JSON.stringify({
              status: 'stopped',
              ...report,
              guidance: buildStopGuidance(report.source, 'forced'),
            }),
          })
          return
        }
      }

      // 常规异常
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (finalText) {
        subLogger.logAssistantMessage(finalText, modelName)
      }
      subLogger.finalize('error')
      markSubAgentDone(agentId, finalText, 'error')

      eventBus.emit({
        type: 'subagent_done',
        agentId,
        name: agentName,
        description,
        success: false,
        output: errorMsg,
      })
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      clearSubAgentControl(agentId)
      cleanup?.()
      sessionProvider?.dispose?.()
    }
  })()
}

/**
 * 解析子 Agent 使用的 provider + model。
 * 子 Agent 不跨供应商，始终继承父 Agent 的 provider，仅可切换同 provider 下的 model。
 * 优先级：LLM 显式传 model → config.subAgentModel → 继承父 Agent
 */
function resolveSubAgentProvider(
  modelArg: string | undefined,
  ctx: ToolContext,
): { provider: import('@providers/provider.js').LLMProvider; providerName: string; modelName: string } {
  const config = ctx.config ?? configManager.load()
  const parentProvider = ctx.providerName ?? 'unknown'

  // 确定目标模型：LLM 显式指定 > config.subAgentModel > 继承父 Agent
  const targetModel = modelArg?.trim() || config.subAgentModel?.trim() || (ctx.model ?? 'unknown')

  return {
    provider: ctx.provider!,
    providerName: parentProvider,
    modelName: targetModel,
  }
}

/** 生成 17 位 hex ID */
function generateAgentId(): string {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, 17)
}

/**
 * 创建子 Agent 专用 SessionLogger。
 * 目录：<sessions>/<projectSlug>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 */
function createSubagentLogger(
  agentId: string,
  cwd: string,
  provider: string,
  model: string,
  parentSessionId?: string,
): SessionLogger {
  const logger = new SessionLogger(sessionStore)
  if (!parentSessionId) return logger

  try {
    const virtualSessionId = sessionStore.createSubagent(
      agentId, parentSessionId, cwd, provider, model,
    )
    try {
      const snapshot = sessionStore.loadMessages(virtualSessionId)
      logger.bind(virtualSessionId, snapshot.leafEventUuid)
    } catch {
      logger.bind(virtualSessionId)
    }
  } catch {
    // JSONL 创建失败不阻断执行
  }
  return logger
}

/**
 * 构建 todo 上下文摘要，注入到 SubAgent 的 prompt 前面。
 *
 * 让 SubAgent 了解主 Agent 的全局任务分工，知道自己负责哪一部分。
 * 返回 null 表示没有 todo 或 todo 为空。
 */
function buildTodoContext(): string | null {
  const todos = getTodos()
  if (todos.length === 0) return null

  const lines = todos.map(t => {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'
    return `  ${icon} ${t.content}`
  })

  return [
    '[Current task plan from the main agent]:',
    ...lines,
    '',
    'You are responsible for ONE of these tasks. Focus on your assigned task only.',
  ].join('\n')
}

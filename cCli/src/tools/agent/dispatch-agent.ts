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
import { sessionStore } from '@persistence/index.js'
import { SessionLogger } from '@observability/session-logger.js'
import { configManager } from '@config/config-manager.js'
import { getOrCreateProvider } from '@providers/registry.js'
import {
  registerSubAgent, consumeAgentEvent, markSubAgentDone,
  setSubAgentSessionId, resolveAgentName,
} from './store.js'
import { agentDefinitionRegistry } from './definition-registry.js'
import type { ToolPolicy, AgentCompletedOutput, AgentAsyncLaunchedOutput, AgentErrorOutput } from './types.js'
import { eventBus } from '@core/event-bus.js'

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 硬编码排除 — 所有子 Agent 类型必须遵守，不可通过 toolPolicy 覆盖 */
const ALWAYS_EXCLUDE = ['dispatch_agent', 'ask_user_question']

/** general 类型的默认 maxTurns（未匹配到定义时的兜底） */
const DEFAULT_MAX_TURNS = 25

// ═══════════════════════════════════════════════
// DispatchAgentTool
// ═══════════════════════════════════════════════

export class DispatchAgentTool implements StreamableTool {
  readonly name = 'dispatch_agent'

  get description(): string {
    const typeList = agentDefinitionRegistry.buildTypeDescriptions()
    return [
      'Dispatch a sub-agent to handle a task independently.',
      '',
      'Agent types:',
      typeList,
      '',
      'Each sub-agent has a name (auto-generated or specified) for tracking.',
      'Set run_in_background=true for parallel execution.',
      '',
      'Output is a JSON object with fields: status, agentId, name, agentType, result.',
      '',
      'IMPORTANT: The sub-agent result is ALREADY VERIFIED.',
      'Do NOT re-verify or re-run commands the sub-agent completed.',
      'Simply relay the result to the user.',
    ].join('\n')
  }

  get parameters() {
    return {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string' as const,
          description: 'Short task description (3-5 words)',
        },
        prompt: {
          type: 'string' as const,
          description: 'Complete instructions for the sub-agent',
        },
        subagent_type: {
          type: 'string' as const,
          enum: agentDefinitionRegistry.getTypeNames(),
          description:
            'Agent type — determines tools and behavior:\n' +
            agentDefinitionRegistry.buildTypeDescriptions(),
        },
        name: {
          type: 'string' as const,
          description:
            'Human-readable name for this sub-agent (e.g. "search-auth", "plan-refactor"). ' +
            'Used in logs, UI, and progress tracking. Auto-generated if omitted.',
        },
        model: {
          type: 'string' as const,
          description:
            'Override model (e.g. "glm-5", "claude-sonnet-4-6"). Inherits parent model if omitted.',
        },
        run_in_background: {
          type: 'boolean' as const,
          description: 'Run in background, return immediately with agentId',
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

    // 构建受限工具集
    const subRegistry = buildSubRegistry(ctx.registry, definition.toolPolicy)

    // 为子 Agent 创建独立的会话级 Provider（隔离 ChatOpenAI 等有状态资源）
    const sessionProvider = subProvider.createSession?.() ?? subProvider

    // 创建子 AgentLoop
    const subLoop = new AgentLoop(sessionProvider, subRegistry, {
      model: modelName,
      provider: providerName,
      signal: ctx.signal,
      maxTurns,
      isSidechain: true,
      agentId,
      systemPrompt: definition.getSystemPrompt(),
    })

    subLogger.logUserMessage(prompt)

    // ── 后台模式 ──
    if (runInBackground) {
      runSubAgentInBackground(subLoop, prompt, agentId, agentName, agentType, description, subLogger, modelName, maxTurns, sessionProvider)

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
        description,
      }
      return { success: true, output: JSON.stringify(output) }
    }

    // ── 前台模式 ──
    let finalText = ''
    let currentTurn = 0

    try {
      for await (const event of subLoop.run([{ role: 'user', content: prompt }])) {
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
            break

          default:
            break
        }
      }

      subLogger.logAssistantMessage(finalText || '(no text output)', modelName)
      subLogger.finalize()
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
      return { success: true, output: JSON.stringify(output) }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (finalText) {
        subLogger.logAssistantMessage(finalText, modelName)
      }
      subLogger.finalize()
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
      sessionProvider.dispose?.()
    }
  }
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

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

/**
 * 后台执行子 AgentLoop（fire-and-forget）。
 * 事件双写到 store + JSONL，通过 eventBus 广播进度。
 */
function runSubAgentInBackground(
  subLoop: AgentLoop,
  prompt: string,
  agentId: string,
  agentName: string,
  agentType: string,
  description: string,
  subLogger: SessionLogger,
  modelName: string,
  maxTurns: number,
  sessionProvider?: import('@providers/provider.js').LLMProvider,
): void {
  let finalText = ''
  let currentTurn = 0

  void (async () => {
    try {
      for await (const event of subLoop.run([{ role: 'user', content: prompt }])) {
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

          default:
            break
        }
      }

      subLogger.logAssistantMessage(finalText || '(no text output)', modelName)
      subLogger.finalize()
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
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (finalText) {
        subLogger.logAssistantMessage(finalText, modelName)
      }
      subLogger.finalize()
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
      sessionProvider?.dispose?.()
    }
  })()
}

/**
 * 解析子 Agent 使用的 provider + model。
 * 优先级：显式指定 model → 继承父 Agent
 */
function resolveSubAgentProvider(
  modelArg: string | undefined,
  ctx: ToolContext,
): { provider: import('@providers/provider.js').LLMProvider; providerName: string; modelName: string } {
  if (!modelArg?.trim()) {
    return {
      provider: ctx.provider!,
      providerName: ctx.providerName ?? 'unknown',
      modelName: ctx.model ?? 'unknown',
    }
  }

  const model = modelArg.trim()
  const config = configManager.load()

  for (const [name, providerCfg] of Object.entries(config.providers)) {
    if (!providerCfg) continue
    if (providerCfg.models.includes(model)) {
      const provider = getOrCreateProvider(name, config)
      return { provider, providerName: name, modelName: model }
    }
  }

  return {
    provider: ctx.provider!,
    providerName: ctx.providerName ?? 'unknown',
    modelName: model,
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

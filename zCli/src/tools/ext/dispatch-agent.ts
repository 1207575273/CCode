// src/tools/dispatch-agent.ts

/**
 * DispatchAgentTool — 派发子 Agent 执行独立任务。
 *
 * 实现 StreamableTool 接口：
 * - stream(): yield 子 Agent 进度事件 (subagent_progress)，return 最终结果
 * - execute(): fallback，消费 stream() 但丢弃中间事件
 *
 * 子 Agent 拥有完整的 AgentLoop（多轮 LLM + 工具调用），
 * 但排除 dispatch_agent 工具防止递归派发。
 *
 * 每个子 Agent 的完整事件历史写入独立 JSONL 文件：
 *   <sessions>/<projectSlug>/subagents/agent-<agentId>.jsonl
 */

import type { ToolContext, ToolResult, StreamableTool } from '../core/types.js'
import { AgentLoop } from '@core/agent-loop.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { sessionStore } from '@persistence/index.js'
import { SessionLogger } from '@observability/session-logger.js'
import { configManager } from '@config/config-manager.js'
import { createProvider } from '@providers/registry.js'
import {
  registerSubAgent, consumeAgentEvent, markSubAgentDone, setSubAgentSessionId,
} from './subagent-store.js'
import { eventBus } from '@core/event-bus.js'

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 子 Agent 最大轮次（比主 Agent 默认 20 少，防止子任务过长） */
const SUB_AGENT_MAX_TURNS = 25

/** 子 Agent 系统提示词 */
const SUB_AGENT_SYSTEM_PROMPT = `You are a sub-agent. Complete the assigned task autonomously.
Constraints:
- Focus solely on the given task
- Do NOT dispatch further sub-agents
- Do NOT ask questions — you have no user interaction
- When done, output your final result as plain text`

// ═══════════════════════════════════════════════
// DispatchAgentTool
// ═══════════════════════════════════════════════

export class DispatchAgentTool implements StreamableTool {
  readonly name = 'dispatch_agent'
  readonly description =
    'Dispatch a sub-agent to handle a task independently. ' +
    'The sub-agent runs a complete agent loop with its own context, ' +
    'executes tools as needed, and returns the final result. ' +
    'Use this for tasks that can be done in parallel or need isolation.\n\n' +
    'Set run_in_background=true to run the sub-agent in the background. ' +
    'It returns immediately with agentId. Use task_output with the agentId to check progress.\n\n' +
    'IMPORTANT: The sub-agent result is ALREADY VERIFIED. ' +
    'When you receive the result, trust it and relay it to the user directly. ' +
    'Do NOT re-verify, re-create files, or re-run commands that the sub-agent already completed. ' +
    'Simply summarize the result for the user.'
  readonly parameters = {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short task description (for logging and progress display)',
      },
      prompt: {
        type: 'string',
        description: 'Complete instructions for the sub-agent.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run sub-agent in background, return immediately with agentId.',
      },
      // 内部预留，暂不开放给 LLM：
      // model: { type: 'string', description: '子 Agent 使用的模型（不同于主 Agent）' }
      // type: { type: 'string', enum: ['general', 'explore', 'plan'] }
    },
    required: ['description', 'prompt'],
  }
  /** dispatch_agent 本身不危险；子 Agent 内部的工具因 isSidechain 自动批准 */
  readonly dangerous = false

  /**
   * fallback 执行：消费 stream() 但丢弃中间事件，只返回最终结果。
   * 用于不支持流式的调用路径（如并行执行器）。
   */
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gen = this.stream(args, ctx)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    return next.value
  }

  /**
   * 流式执行：yield 子 Agent 进度事件，return 最终结果。
   *
   * 事件三写：
   *   1. yield → 主 AgentLoop generator 链路（UI 显示 + 主 JSONL）
   *   2. subLogger.consume() → 子 Agent 独立 JSONL（完整审计）
   *   3. subagent-store → 内存缓存（SubAgentPanel 实时查看）
   *
   * run_in_background=true 时：
   *   启动后立即返回 agentId，子 Agent 在后台独立运行。
   *   事件写入 store + JSONL，通过 eventBus 广播进度。
   */
  async *stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<AgentEvent, ToolResult> {
    const description = String(args['description'] ?? '')
    const prompt = String(args['prompt'] ?? '')
    const runInBackground = args['run_in_background'] === true

    // 参数校验
    if (!prompt.trim()) {
      return { success: false, output: '', error: 'prompt 不能为空' }
    }

    // 前置条件：需要 provider 和 registry 构建子 AgentLoop
    if (!ctx.provider || !ctx.registry) {
      return { success: false, output: '', error: 'dispatch_agent 需要 ToolContext 中的 provider 和 registry' }
    }

    const agentId = generateAgentId()

    // 解析子 Agent 使用的 provider + model
    const { provider: subProvider, providerName, modelName } = resolveSubAgentProvider(
      args['model'] as string | undefined,
      ctx,
    )

    // 创建子 Agent 独立 JSONL（完整审计记录）
    const subLogger = createSubagentLogger(agentId, ctx.cwd, providerName, modelName, ctx.sessionId)

    // 注册到 subagent-store（内存缓存）
    registerSubAgent(agentId, description, SUB_AGENT_MAX_TURNS)
    // 关联 JSONL sessionId（回放用）
    if (subLogger.sessionId) {
      setSubAgentSessionId(agentId, subLogger.sessionId)
    }

    // 构建子 Agent 受限工具集
    const subRegistry = ctx.registry.cloneWithout('dispatch_agent', 'ask_user_question')

    // 创建子 AgentLoop
    const subLoop = new AgentLoop(subProvider, subRegistry, {
      model: modelName,
      provider: providerName,
      signal: ctx.signal,
      maxTurns: SUB_AGENT_MAX_TURNS,
      isSidechain: true,
      agentId,
      systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
    })

    // 记录子 Agent 收到的用户提示到独立 JSONL
    subLogger.logUserMessage(prompt)

    // ---- 后台运行模式：启动后立即返回 ----
    if (runInBackground) {
      // fire-and-forget：后台执行子 AgentLoop
      runSubAgentInBackground(subLoop, prompt, agentId, description, subLogger, modelName)

      // 通知 UI 新的后台 SubAgent 已启动
      yield {
        type: 'subagent_progress',
        agentId,
        description,
        turn: 0,
        maxTurns: SUB_AGENT_MAX_TURNS,
      } satisfies AgentEvent

      return {
        success: true,
        output: `Sub-agent started in background (agentId: ${agentId}, task: ${description}). ` +
          `The agent is running autonomously. Its progress is shown in the SubAgent panel. ` +
          `Do NOT call task_output to check — just wait for it to finish and continue with other work.`,
      }
    }

    // ---- 前台运行模式（原有逻辑 + store 写入） ----
    let finalText = ''
    let currentTurn = 0

    try {
      for await (const event of subLoop.run([{ role: 'user', content: prompt }])) {
        // 三写：JSONL + store + yield
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
              agentId, description,
              turn: currentTurn, maxTurns: SUB_AGENT_MAX_TURNS,
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
              agentId, description,
              turn: currentTurn, maxTurns: SUB_AGENT_MAX_TURNS,
            } satisfies AgentEvent
            eventBus.emit({
              type: 'subagent_event', agentId,
              detail: { kind: 'tool_done', toolName: event.toolName, toolCallId: event.toolCallId, durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary },
            })
            break

          case 'llm_start':
            currentTurn++
            yield {
              type: 'subagent_progress', agentId, description,
              turn: currentTurn, maxTurns: SUB_AGENT_MAX_TURNS,
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

      return {
        success: true,
        output: wrapSubagentResult(finalText, description),
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (finalText) {
        subLogger.logAssistantMessage(finalText, modelName)
      }
      subLogger.finalize()
      markSubAgentDone(agentId, finalText, 'error')

      return {
        success: false,
        output: finalText,
        error: `子 Agent 执行异常: ${errorMsg}`,
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

/**
 * 后台执行子 AgentLoop（fire-and-forget）。
 *
 * 事件双写到 store + JSONL，并通过 eventBus 广播 subagent_progress 给 UI。
 * 完成后广播 subagent_done 通知主 UI 更新。
 */
function runSubAgentInBackground(
  subLoop: AgentLoop,
  prompt: string,
  agentId: string,
  description: string,
  subLogger: SessionLogger,
  modelName: string,
): void {
  let finalText = ''
  let currentTurn = 0

  // 异步执行，不阻塞调用方
  void (async () => {
    try {
      for await (const event of subLoop.run([{ role: 'user', content: prompt }])) {
        // 双写：JSONL + store
        subLogger.consume(event)
        consumeAgentEvent(agentId, event)

        // 通过 eventBus 广播进度 + 详细事件，UI 实时更新
        switch (event.type) {
          case 'text':
            finalText += event.text
            eventBus.emit({ type: 'subagent_event', agentId, detail: { kind: 'text', text: event.text } })
            break

          case 'llm_start':
            currentTurn++
            eventBus.emit({
              type: 'subagent_progress',
              agentId, description,
              turn: currentTurn, maxTurns: SUB_AGENT_MAX_TURNS,
            })
            break

          case 'tool_start':
            eventBus.emit({
              type: 'subagent_progress',
              agentId, description,
              turn: currentTurn, maxTurns: SUB_AGENT_MAX_TURNS,
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
              agentId, description,
              turn: currentTurn, maxTurns: SUB_AGENT_MAX_TURNS,
            })
            eventBus.emit({
              type: 'subagent_event', agentId,
              detail: { kind: 'tool_done', toolName: event.toolName, toolCallId: event.toolCallId, durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary },
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

      // 广播完成事件
      eventBus.emit({
        type: 'subagent_done',
        agentId,
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
        description,
        success: false,
        output: errorMsg,
      })
    }
  })()
}

/**
 * 包装子 Agent 返回结果，加上信任标记防止主 Agent 重复验证。
 *
 * 主 Agent（尤其是判断力较弱的模型）收到子 Agent 结果后，
 * 容易不信任结果而重复执行同样的操作（创建文件、编译、curl 验证等）。
 * 通过在结果前加上明确的指令来引导主 Agent 直接使用结果。
 */
function wrapSubagentResult(finalText: string, description: string): string {
  if (!finalText.trim()) {
    return '(sub-agent completed with no text output)'
  }
  return [
    `[Sub-agent completed: ${description}]`,
    '',
    finalText,
    '',
    '[INSTRUCTION: The sub-agent has already executed all steps and verified the result.',
    'Do NOT repeat any of the above actions. Simply relay this result to the user.]',
  ].join('\n')
}

/**
 * 解析子 Agent 使用的 provider + model。
 *
 * 优先级：
 * 1. 显式指定 model → 从 config 中查找包含该模型的 provider，创建新实例
 * 2. 未指定 → 继承父 Agent 的 provider + model
 */
function resolveSubAgentProvider(
  modelArg: string | undefined,
  ctx: ToolContext,
): { provider: import('@providers/provider.js').LLMProvider; providerName: string; modelName: string } {
  // 未指定 model，继承父 Agent
  if (!modelArg?.trim()) {
    return {
      provider: ctx.provider!,
      providerName: ctx.providerName ?? 'unknown',
      modelName: ctx.model ?? 'unknown',
    }
  }

  const model = modelArg.trim()
  const config = configManager.load()

  // 遍历 config.providers，找到包含该模型的 provider
  for (const [name, providerCfg] of Object.entries(config.providers)) {
    if (!providerCfg) continue
    if (providerCfg.models.includes(model)) {
      const provider = createProvider(name, config)
      return { provider, providerName: name, modelName: model }
    }
  }

  // 找不到匹配的 provider，回退到父 Agent 但使用指定的 model
  // （可能是父 provider 支持但未在 models 列表中显式声明的模型）
  return {
    provider: ctx.provider!,
    providerName: ctx.providerName ?? 'unknown',
    modelName: model,
  }
}

/** 生成 17 位 hex ID（与 Claude Code 子 Agent ID 格式对齐） */
function generateAgentId(): string {
  const bytes = new Uint8Array(9) // 9 bytes = 18 hex chars, 取前 17 位
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, 17)
}

/**
 * 创建子 Agent 专用 SessionLogger。
 *
 * 目录结构：<sessions>/<projectSlug>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 * parentSessionId 缺失时跳过 JSONL 创建（logger 保持未绑定状态，consume 为 no-op）。
 */
function createSubagentLogger(
  agentId: string,
  cwd: string,
  provider: string,
  model: string,
  parentSessionId?: string,
): SessionLogger {
  const logger = new SessionLogger(sessionStore)
  if (!parentSessionId) return logger // 没有父会话 ID 则不写日志

  try {
    const virtualSessionId = sessionStore.createSubagent(
      agentId, parentSessionId, cwd, provider, model,
    )
    // 绑定到 subagent JSONL，后续 consume/log 写入该文件
    // createSubagent 已写入 session_start，需读回 lastEventUuid
    try {
      const snapshot = sessionStore.loadMessages(virtualSessionId)
      logger.bind(virtualSessionId, snapshot.leafEventUuid)
    } catch {
      logger.bind(virtualSessionId)
    }
  } catch {
    // JSONL 创建失败不阻断子 Agent 执行，logger 保持未绑定状态（consume 为 no-op）
  }
  return logger
}

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

import type { ToolContext, ToolResult, StreamableTool } from './types.js'
import { AgentLoop } from '@core/agent-loop.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { sessionStore } from '@persistence/index.js'
import { SessionLogger } from '@observability/session-logger.js'

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

/** 子 Agent 最大轮次（比主 Agent 默认 20 少，防止子任务过长） */
const SUB_AGENT_MAX_TURNS = 15

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
      // 二期预留：子 Agent 类型，映射到预设工具集
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
   * 事件双写：
   *   1. yield → 主 AgentLoop generator 链路（UI 显示 + 主 JSONL）
   *   2. subLogger.consume() → 子 Agent 独立 JSONL（完整审计）
   */
  async *stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<AgentEvent, ToolResult> {
    const description = String(args['description'] ?? '')
    const prompt = String(args['prompt'] ?? '')

    // 参数校验
    if (!prompt.trim()) {
      return { success: false, output: '', error: 'prompt 不能为空' }
    }

    // 前置条件：需要 provider 和 registry 构建子 AgentLoop
    if (!ctx.provider || !ctx.registry) {
      return { success: false, output: '', error: 'dispatch_agent 需要 ToolContext 中的 provider 和 registry' }
    }

    const agentId = generateAgentId()
    const providerName = ctx.providerName ?? 'unknown'
    const modelName = ctx.model ?? 'unknown'

    // 创建子 Agent 独立 JSONL（完整审计记录）
    const subLogger = createSubagentLogger(agentId, ctx.cwd, providerName, modelName, ctx.sessionId)

    // 构建子 Agent 受限工具集：排除 dispatch_agent 防递归
    // 排除 dispatch_agent 防递归、排除 ask_user_question 因子 Agent 无用户交互
    const subRegistry = ctx.registry.cloneWithout('dispatch_agent', 'ask_user_question')

    // 创建子 AgentLoop
    const subLoop = new AgentLoop(ctx.provider, subRegistry, {
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

    // 运行子 AgentLoop，事件双写
    let finalText = ''
    let currentTurn = 0

    try {
      for await (const event of subLoop.run([{ role: 'user', content: prompt }])) {
        // 写入子 Agent 独立 JSONL（所有事件完整记录）
        subLogger.consume(event)

        switch (event.type) {
          case 'text':
            // 累积子 Agent 的文本输出作为最终结果
            finalText += event.text
            break

          case 'tool_start':
            // 透传为 subagent_progress 事件，UI 可实时展示子 Agent 正在做什么
            yield {
              type: 'subagent_progress',
              agentId,
              description,
              turn: currentTurn,
              maxTurns: SUB_AGENT_MAX_TURNS,
              currentTool: event.toolName,
            } satisfies AgentEvent
            break

          case 'tool_done':
            // 工具完成，清除 currentTool
            yield {
              type: 'subagent_progress',
              agentId,
              description,
              turn: currentTurn,
              maxTurns: SUB_AGENT_MAX_TURNS,
            } satisfies AgentEvent
            break

          case 'llm_start':
            // LLM 调用开始 = 新的一轮
            currentTurn++
            yield {
              type: 'subagent_progress',
              agentId,
              description,
              turn: currentTurn,
              maxTurns: SUB_AGENT_MAX_TURNS,
            } satisfies AgentEvent
            break

          case 'llm_usage':
            // token 计量事件直接透传，SessionLogger 可统计子 Agent 消耗
            yield event
            break

          case 'error':
            // 子 Agent 内部错误，记录但不中止（让子 AgentLoop 自行处理）
            break

          case 'done':
            // 子 Agent 正常完成
            break

          default:
            // permission_request 不会触发（isSidechain 自动批准）
            // 其他事件忽略
            break
        }
      }

      // 记录子 Agent 最终输出 + 写入 session_end 汇总
      subLogger.logAssistantMessage(finalText || '(no text output)', modelName)
      subLogger.finalize()

      return {
        success: true,
        output: wrapSubagentResult(finalText, description),
      }
    } catch (err) {
      // 子 Agent 异常（如 AbortError），记录部分结果并关闭 JSONL
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (finalText) {
        subLogger.logAssistantMessage(finalText, modelName)
      }
      subLogger.finalize()

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

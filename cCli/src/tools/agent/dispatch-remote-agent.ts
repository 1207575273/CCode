// src/tools/agent/dispatch-remote-agent.ts

/**
 * DispatchRemoteAgentTool — 调用远端 A2A Agent 执行任务（A2A 客户端能力）。
 *
 * 与 DispatchAgentTool（本地子 Agent）并列，但目标是「另一个独立部署的 Agent」：
 * - 通过 A2A 协议（@a2a-js/sdk）与远端通信
 * - 远端 Agent 对 CCode 是不透明的（opaque），只看 AgentCard 能力描述
 * - 把远端的 A2A Task 流式事件投影成 SubagentEvent，复用 CLI 现有卡片渲染
 *
 * 安全底线（方案 §5.3 / D-5）：只能调用「已信任白名单」中的 Agent。
 * LLM 不能对任意 URL 发起请求，必须先由用户通过 /a2a add 显式信任。
 *
 * 输出为结构化 JSON（A2ADispatchResult）。
 */

import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolResult, StreamableTool } from '../core/types.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { registerSubAgent, resolveAgentName, markSubAgentDone } from './store.js'
import { A2AClientWrapper } from '../../a2a/client.js'
import { mapToA2AEvent, a2aEventToSubagentEvent } from '../../a2a/event-mapper.js'
import { A2ATrustStore } from '@config/a2a-config.js'
import type { TrustedAgent, A2AStreamEvent, A2ADispatchResult, TaskState } from '../../a2a/types.js'
import { INTERRUPT_TASK_STATES } from '../../a2a/types.js'

// ═══════════════════════════════════════════════
// 可注入依赖（便于测试）
// ═══════════════════════════════════════════════

/** 远端客户端最小接口 — 生产用 A2AClientWrapper，测试可注入 fake */
export interface RemoteAgentClient {
  sendMessageStream(text: string, contextId?: string): AsyncGenerator<A2AStreamEvent>
  cancelTask(taskId: string): Promise<void>
}

/** 信任白名单最小接口 */
export interface TrustLookup {
  findByUrl(url: string): Promise<TrustedAgent | undefined>
  list(): Promise<TrustedAgent[]>
}

interface DispatchRemoteAgentDeps {
  /** 信任白名单（默认真实 A2ATrustStore） */
  trustStore?: TrustLookup
  /** 客户端工厂（默认 A2AClientWrapper.create） */
  createClient?: (agent: TrustedAgent) => Promise<RemoteAgentClient>
}

// ═══════════════════════════════════════════════
// TaskState -> A2ADispatchResult.status 映射
// ═══════════════════════════════════════════════

function toDispatchStatus(state: TaskState): A2ADispatchResult['status'] {
  if (state === 'completed') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'canceled') return 'canceled'
  if (state === 'rejected') return 'rejected'
  if (state === 'input-required') return 'input-required'
  if (state === 'auth-required') return 'auth-required'
  // submitted / working / unknown 在流正常结束时不应作为终态，兜底为 completed
  return 'completed'
}

// ═══════════════════════════════════════════════
// DispatchRemoteAgentTool
// ═══════════════════════════════════════════════

export class DispatchRemoteAgentTool implements StreamableTool {
  readonly name = 'dispatch_remote_agent'

  private readonly trustStore: TrustLookup
  private readonly createClient: (agent: TrustedAgent) => Promise<RemoteAgentClient>

  constructor(deps?: DispatchRemoteAgentDeps) {
    this.trustStore = deps?.trustStore ?? new A2ATrustStore()
    this.createClient = deps?.createClient ?? ((agent) => A2AClientWrapper.create(agent))
  }

  get description(): string {
    return [
      '调用远端 A2A Agent 执行任务（通过 Agent2Agent 协议与另一个独立部署的 Agent 协作）。',
      '',
      '使用前提：目标 Agent 必须已被用户信任（通过 /a2a add <url> 加入白名单）。',
      '用 /a2a list 查看当前可调用的远端 Agent。',
      '',
      '参数：',
      '• agent   — 已信任 Agent 的 URL 或别名',
      '• message — 给远端 Agent 的完整指令（远端看不到本地对话历史，需自带上下文）',
      '• context_id — 可选，复用同一会话上下文时传入',
      '',
      '返回结构：status（completed/failed/canceled/rejected/input-required/auth-required）+ output（最终文本）+ artifacts（产物摘要）。',
    ].join('\n')
  }

  get parameters() {
    return {
      type: 'object' as const,
      properties: {
        agent: {
          type: 'string' as const,
          description: '已信任的远端 Agent 的 URL 或别名（见 /a2a list）',
        },
        message: {
          type: 'string' as const,
          description: '给远端 Agent 的完整指令（需自带上下文，远端看不到本地对话）',
        },
        context_id: {
          type: 'string' as const,
          description: '可选，复用远端会话上下文的 contextId',
        },
      },
      required: ['agent', 'message'] as const,
    }
  }

  /** A2A 调用涉及网络出站，标记为危险，走权限确认 */
  readonly dangerous = true

  /** fallback：消费 stream 丢弃中间事件 */
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gen = this.stream(args, ctx)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    return next.value
  }

  async *stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<AgentEvent, ToolResult> {
    const agentRef = String(args['agent'] ?? '').trim()
    const message = String(args['message'] ?? '').trim()
    const contextIdArg = args['context_id'] != null ? String(args['context_id']) : undefined

    // 参数校验（卫语句）
    if (!agentRef) {
      return { success: false, output: '', error: 'agent 不能为空（填已信任 Agent 的 URL 或别名）' }
    }
    if (!message) {
      return { success: false, output: '', error: 'message 不能为空' }
    }

    // 白名单解析：先按 URL 精确匹配，再按 alias / name / id 匹配
    const trusted = await this.resolveTrustedAgent(agentRef)
    if (!trusted) {
      return {
        success: false,
        output: '',
        error: `远端 Agent "${agentRef}" 不在信任白名单中。请先用 /a2a add <url> 信任它，再调用。`,
      }
    }

    // 生成 agentId + 注册到 SubAgent store（让 CLI 卡片可渲染）
    const agentId = `a2a-${randomUUID().slice(0, 8)}`
    const name = resolveAgentName(trusted.alias ?? trusted.name, 'a2a-remote', agentId)
    registerSubAgent({
      agentId,
      name,
      description: message.slice(0, 60),
      agentType: 'a2a-remote',
      modelName: trusted.name,
      maxTurns: 1,
    })

    // 派生宣告 — 绑定 parentToolCallId，UI 据此挂载卡片
    if (ctx.toolCallId) {
      yield {
        type: 'subagent_spawn',
        parentToolCallId: ctx.toolCallId,
        agentId,
        name,
        agentType: 'a2a-remote',
        description: message.slice(0, 60),
        maxTurns: 1,
      }
    }

    // 累积输出
    const artifacts: NonNullable<A2ADispatchResult['artifacts']> = []
    let finalState: TaskState = 'completed'
    let finalText = ''
    let taskId: string | undefined
    let contextId: string | undefined = contextIdArg

    try {
      const client = await this.createClient(trusted)
      const stream = client.sendMessageStream(message, contextIdArg)

      for await (const raw of stream) {
        const evt = mapToA2AEvent(raw, Date.now())

        // 累积领域信息
        switch (evt.kind) {
          case 'task-created':
            taskId = evt.taskId
            contextId = evt.contextId
            finalState = evt.state
            break
          case 'status':
            taskId = evt.taskId
            contextId = evt.contextId
            finalState = evt.state
            if (evt.message) finalText = evt.message
            break
          case 'artifact': {
            const text = extractArtifactText(evt.artifact)
            artifacts.push({
              artifactId: evt.artifact.artifactId,
              ...(evt.artifact.name ? { name: evt.artifact.name } : {}),
              preview: text.slice(0, 200),
            })
            if (text) finalText = finalText ? `${finalText}\n${text}` : text
            break
          }
          case 'message':
            if (evt.text) finalText = evt.text
            break
        }

        // 投影成 SubagentEvent 透传给 CLI UI
        const sub = a2aEventToSubagentEvent(evt, { agentId, parentToolCallId: ctx.toolCallId ?? '', name })
        if (sub) yield sub
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
      markSubAgentDone(agentId, errMsg, 'error')
      const result: A2ADispatchResult = {
        status: 'failed',
        output: '',
        reason: errMsg,
        ...(taskId ? { taskId } : {}),
        ...(contextId ? { contextId } : {}),
      }
      return { success: false, output: JSON.stringify(result), error: errMsg }
    }

    const status = toDispatchStatus(finalState)
    const output = finalText || emptyFallback(agentId)
    markSubAgentDone(agentId, output, status === 'completed' ? 'done' : status === 'canceled' ? 'stopped' : 'error')

    const result: A2ADispatchResult = {
      status,
      output,
      ...(taskId ? { taskId } : {}),
      ...(contextId ? { contextId } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(INTERRUPT_TASK_STATES.has(finalState) || finalState === 'failed' || finalState === 'rejected'
        ? { reason: finalText || `远端 Agent 进入 ${finalState} 状态` }
        : {}),
    }
    return { success: status === 'completed', output: JSON.stringify(result) }
  }

  /** 白名单解析：URL 精确 -> alias/name/id 匹配 */
  private async resolveTrustedAgent(ref: string): Promise<TrustedAgent | undefined> {
    const byUrl = await this.trustStore.findByUrl(ref)
    if (byUrl) return byUrl
    const all = await this.trustStore.list()
    return all.find((a) => a.alias === ref || a.name === ref || a.id === ref)
  }
}

// ═══════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════

/** 从 artifact.parts 提取并拼接 text */
function extractArtifactText(artifact: { parts: Array<{ kind: string; text?: string }> }): string {
  return artifact.parts
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

function emptyFallback(agentId: string): string {
  return `(远端 Agent 未产出文本输出，agentId=${agentId})`
}

// src/a2a/inbound-ui-mirror.ts

/**
 * inbound UI 镜像 — 让被调方"看见"自己被远程委托执行的任务。
 *
 * 背景：本会话作为 A2A Server 被其他会话/Agent 调用时，起一个 sidechain
 * AgentLoop 干活。这些 AgentEvent 原本只被 server-executor 翻译成 A2A 流回传
 * 发起方，被调方自己的界面完全看不到。这里把同一条 AgentEvent 流"镜像"成
 * subagent_* 事件发到 eventBus，让被调方复用现有 SubAgent 卡片渲染：
 *   - CLI：状态卡片（名字 / 轮次 / 当前工具 / 完成态），与发起方对称
 *   - Web：subagent_event 明细 -> SubAgentDrawer 完整消息/工具时间轴
 *
 * 关键纪律：
 * - 不注入被调方主对话历史（subagent 卡片是独立状态），守住"不打断主对话"底线。
 * - 纯旁路：事件原样 yield 透传给下游（server-executor），不改写。
 * - 不发 subagent_spawn（inbound 无父 toolCall）；subagent_progress 即可建卡。
 *   必须先发 progress 建卡，subagent_event 明细才会被 UI 接住。
 */

import { eventBus, type BridgeEvent } from '../core/event-bus.js'
import type { AgentEvent } from '../core/agent-loop.js'

/** inbound 子 Agent 的 agentType 标识（UI 据此区分"别人调我"而非"我调别人"） */
export const INBOUND_AGENT_TYPE = 'a2a-inbound'

/** inbound 卡片展示用的名义最大轮次（sidechain 实际无硬上限，仅用于进度展示） */
const INBOUND_MAX_TURNS = 50

export interface InboundMirrorMeta {
  /** 子 Agent id（由 taskId 派生，保证唯一） */
  agentId: string
  /** 卡片名字（如"来自 :54751 的委托"） */
  name: string
  /** 任务简述（消息预览） */
  description: string
}

/**
 * 把被调方 sidechain 的 AgentEvent 流镜像成 subagent_* 事件，并原样透传。
 * @param emit 注入事件发射函数（默认 eventBus.emit），便于测试。
 */
export async function* mirrorInboundToUI(
  meta: InboundMirrorMeta,
  stream: AsyncGenerator<AgentEvent>,
  emit: (event: BridgeEvent) => void = (e) => eventBus.emit(e),
): AsyncGenerator<AgentEvent> {
  const { agentId, name, description } = meta
  const base = { agentId, name, agentType: INBOUND_AGENT_TYPE, description, maxTurns: INBOUND_MAX_TURNS }

  let turn = 0
  let finalText = ''
  let errored = false

  // 先发一条 progress 建卡（subagent_event 明细才有容器可挂）
  emit({ type: 'subagent_progress', ...base, turn })

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'text':
          finalText += event.text
          emit({ type: 'subagent_event', agentId, detail: { kind: 'text', text: event.text } })
          break
        case 'llm_start':
          turn++
          emit({ type: 'subagent_progress', ...base, turn })
          break
        case 'tool_start':
          emit({ type: 'subagent_progress', ...base, turn, currentTool: event.toolName })
          emit({
            type: 'subagent_event', agentId,
            detail: { kind: 'tool_start', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
          })
          break
        case 'tool_done':
          emit({ type: 'subagent_progress', ...base, turn })
          emit({
            type: 'subagent_event', agentId,
            detail: {
              kind: 'tool_done',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              durationMs: event.durationMs,
              success: event.success,
              ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
            },
          })
          break
        case 'error':
          errored = true
          emit({ type: 'subagent_event', agentId, detail: { kind: 'error', error: event.error } })
          break
        default:
          break
      }
      yield event
    }
    emit({ type: 'subagent_done', agentId, name, description, success: !errored, output: finalText })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emit({ type: 'subagent_event', agentId, detail: { kind: 'error', error: msg } })
    emit({ type: 'subagent_done', agentId, name, description, success: false, output: finalText })
    throw err
  }
}

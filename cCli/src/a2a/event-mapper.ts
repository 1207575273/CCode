// src/a2a/event-mapper.ts
//
// A2A 流式事件映射器 — 纯函数模块，无副作用，无 I/O。
//
// 职责：
//   1. mapToA2AEvent   — 把 SDK A2AStreamEvent 规范化为内部 A2AEvent
//   2. a2aEventToSubagentEvent — 把 A2AEvent 投影为 CLI 现有 SubagentEvent（复用渲染层）
//
// 设计依据：总体方案 §10 M1 dispatch_remote_agent，A2A SDK 边界收拢在 types.ts。

import type {
  A2AStreamEvent,
  A2AEvent,
  Part,
} from './types.js'
import { TERMINAL_TASK_STATES } from './types.js'
import type { SubagentEvent } from '@core/agent-events.js'

// ─── 内部工具函数 ─────────────────────────────────────────────────────────────

/**
 * 从 Part[] 中提取所有 kind==='text' 的文本并拼接。
 * 其他 kind（file / data 等）静默忽略。
 */
function extractText(parts: Part[]): string {
  return parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map(p => p.text)
    .join('')
}

// ─── mapToA2AEvent ────────────────────────────────────────────────────────────

/**
 * 把 SDK 原始流式事件规范化为内部 A2AEvent。
 *
 * @param raw - SDK A2AStreamEvent（Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent）
 * @param ts  - 调用方传入的毫秒时间戳，不在内部调用 Date.now()，保证纯函数可测
 */
export function mapToA2AEvent(raw: A2AStreamEvent, ts: number): A2AEvent {
  switch (raw.kind) {
    case 'task': {
      return {
        kind: 'task-created',
        taskId: raw.id,
        contextId: raw.contextId,
        state: raw.status.state,
        ts,
      }
    }

    case 'status-update': {
      // 从 status.message.parts 提取文本；无 message 时 key 不出现（exactOptionalPropertyTypes）
      const msgText =
        raw.status.message != null ? extractText(raw.status.message.parts) : undefined

      return {
        kind: 'status',
        taskId: raw.taskId,
        contextId: raw.contextId,
        state: raw.status.state,
        // 条件展开：无文本时不写入 message key
        ...(msgText != null && msgText.length > 0 ? { message: msgText } : {}),
        final: raw.final,
        ts,
      }
    }

    case 'artifact-update': {
      return {
        kind: 'artifact',
        taskId: raw.taskId,
        contextId: raw.contextId,
        artifact: raw.artifact,
        // lastChunk 可选，缺省 false
        lastChunk: raw.lastChunk ?? false,
        ts,
      }
    }

    case 'message': {
      const text = extractText(raw.parts)
      return {
        kind: 'message',
        messageId: raw.messageId,
        // 条件展开：无 contextId 时不写入 key
        ...(raw.contextId != null ? { contextId: raw.contextId } : {}),
        text,
        ts,
      }
    }
  }
}

// ─── a2aEventToSubagentEvent ──────────────────────────────────────────────────

/**
 * 把内部 A2AEvent 投影为 CLI SubagentEvent，供主渲染层复用。
 *
 * 映射规则：
 * - task-created  -> null（spawn 由工具自身在调用前 yield，此处不重复）
 * - status + 非终态 -> subagent_progress
 * - status + 终态   -> subagent_done（completed => success=true，其余 => false）
 * - artifact      -> subagent_progress（description 标注产物名）
 * - message       -> subagent_progress（description = 消息文本）
 */
export function a2aEventToSubagentEvent(
  evt: A2AEvent,
  ctx: { agentId: string; parentToolCallId: string; name: string },
): SubagentEvent | null {
  const { agentId, name } = ctx
  const agentType = 'a2a-remote'

  switch (evt.kind) {
    case 'task-created': {
      // spawn 由工具自己发，此处不再重复
      return null
    }

    case 'status': {
      const isTerminal = TERMINAL_TASK_STATES.has(evt.state)

      if (isTerminal) {
        return {
          type: 'subagent_done',
          agentId,
          name,
          description: `A2A 任务结束，state=${evt.state}`,
          success: evt.state === 'completed',
          output: evt.message ?? '',
        }
      }

      // 非终态 -> progress；把 state 和 message 体现在 description / currentTool
      const stateLabel = `[${evt.state}]`
      const description = evt.message != null
        ? `${stateLabel} ${evt.message}`
        : stateLabel

      return {
        type: 'subagent_progress',
        agentId,
        name,
        agentType,
        description,
        turn: 0,
        maxTurns: 0,
        // currentTool 可选；不挂载时用条件展开避免写 undefined
        ...(evt.state !== 'working' ? { currentTool: evt.state } : {}),
      }
    }

    case 'artifact': {
      const artifactLabel = evt.artifact.name ?? evt.artifact.artifactId
      return {
        type: 'subagent_progress',
        agentId,
        name,
        agentType,
        description: `产出 artifact: ${artifactLabel}`,
        turn: 0,
        maxTurns: 0,
      }
    }

    case 'message': {
      return {
        type: 'subagent_progress',
        agentId,
        name,
        agentType,
        description: evt.text,
        turn: 0,
        maxTurns: 0,
      }
    }
  }
}

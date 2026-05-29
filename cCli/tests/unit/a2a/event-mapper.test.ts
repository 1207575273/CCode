// tests/unit/a2a/event-mapper.test.ts
//
// TDD RED 阶段：先写测试，此时 src/a2a/event-mapper.ts 尚不存在，预期全部失败。

import { describe, it, expect } from 'vitest'
import { mapToA2AEvent, a2aEventToSubagentEvent } from '../../../src/a2a/event-mapper.js'
import type {
  A2AStreamEvent,
  A2AEvent,
  Task,
  Message,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Artifact,
} from '../../../src/a2a/types.js'

// ─── 测试数据工厂 ────────────────────────────────────────────────────────────

const FIXED_TS = 1_700_000_000_000

/** 构造最小 Task 事件 */
function makeTask(state: string = 'submitted'): Task {
  return {
    kind: 'task',
    id: 'task-001',
    contextId: 'ctx-001',
    status: { state: state as Task['status']['state'] },
  }
}

/** 构造 TaskStatusUpdateEvent */
function makeStatusUpdate(
  state: string,
  messageText?: string,
  isFinal: boolean = false,
): TaskStatusUpdateEvent {
  const base: TaskStatusUpdateEvent = {
    kind: 'status-update',
    taskId: 'task-001',
    contextId: 'ctx-001',
    status: {
      state: state as TaskStatusUpdateEvent['status']['state'],
      ...(messageText != null
        ? {
            message: {
              kind: 'message',
              messageId: 'msg-001',
              role: 'agent',
              parts: [{ kind: 'text', text: messageText }],
            },
          }
        : {}),
    },
    final: isFinal,
  }
  return base
}

/** 构造 TaskArtifactUpdateEvent */
function makeArtifactUpdate(lastChunk?: boolean): TaskArtifactUpdateEvent {
  const base: TaskArtifactUpdateEvent = {
    kind: 'artifact-update',
    taskId: 'task-001',
    contextId: 'ctx-001',
    artifact: {
      artifactId: 'art-001',
      name: 'result.txt',
      parts: [{ kind: 'text', text: '产物内容' }],
    },
    ...(lastChunk != null ? { lastChunk } : {}),
  }
  return base
}

/** 构造 Message 事件 */
function makeMessage(text: string, contextId?: string): Message {
  return {
    kind: 'message',
    messageId: 'msg-001',
    role: 'agent',
    parts: [{ kind: 'text', text }],
    ...(contextId != null ? { contextId } : {}),
  }
}

// ─── mapToA2AEvent 测试 ───────────────────────────────────────────────────────

describe('mapToA2AEvent', () => {
  // --- 'task' kind ---

  it('should_map_task_kind_when_raw_is_Task', () => {
    const raw = makeTask('submitted')
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('task-created')
    if (result.kind !== 'task-created') return
    expect(result.taskId).toBe('task-001')
    expect(result.contextId).toBe('ctx-001')
    expect(result.state).toBe('submitted')
    expect(result.ts).toBe(FIXED_TS)
  })

  it('should_map_task_kind_with_working_state', () => {
    const raw = makeTask('working')
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('task-created')
    if (result.kind !== 'task-created') return
    expect(result.state).toBe('working')
  })

  // --- 'status-update' kind ---

  it('should_map_status_update_when_state_is_working', () => {
    const raw = makeStatusUpdate('working', undefined, false)
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('status')
    if (result.kind !== 'status') return
    expect(result.taskId).toBe('task-001')
    expect(result.contextId).toBe('ctx-001')
    expect(result.state).toBe('working')
    expect(result.final).toBe(false)
    expect(result.ts).toBe(FIXED_TS)
  })

  it('should_extract_message_text_from_parts_when_status_has_message', () => {
    const raw = makeStatusUpdate('completed', '任务已完成', true)
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('status')
    if (result.kind !== 'status') return
    expect(result.message).toBe('任务已完成')
    expect(result.final).toBe(true)
  })

  it('should_not_include_message_key_when_status_has_no_message', () => {
    // exactOptionalPropertyTypes 验证：无 message 时 key 不应存在
    const raw = makeStatusUpdate('working')
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('status')
    expect('message' in result).toBe(false)
  })

  it('should_concatenate_multiple_text_parts_when_message_has_multiple_parts', () => {
    const raw: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: 'task-001',
      contextId: 'ctx-001',
      status: {
        state: 'completed',
        message: {
          kind: 'message',
          messageId: 'msg-002',
          role: 'agent',
          parts: [
            { kind: 'text', text: '第一段' },
            { kind: 'text', text: '第二段' },
          ],
        },
      },
      final: true,
    }
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('status')
    if (result.kind !== 'status') return
    expect(result.message).toBe('第一段第二段')
  })

  // --- 'artifact-update' kind ---

  it('should_map_artifact_update_when_raw_is_TaskArtifactUpdateEvent', () => {
    const raw = makeArtifactUpdate(true)
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('artifact')
    if (result.kind !== 'artifact') return
    expect(result.taskId).toBe('task-001')
    expect(result.contextId).toBe('ctx-001')
    expect(result.artifact.artifactId).toBe('art-001')
    expect(result.lastChunk).toBe(true)
    expect(result.ts).toBe(FIXED_TS)
  })

  it('should_default_lastChunk_to_false_when_not_provided', () => {
    // lastChunk 缺省时应为 false，不依赖 undefined
    const raw = makeArtifactUpdate()
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('artifact')
    if (result.kind !== 'artifact') return
    expect(result.lastChunk).toBe(false)
  })

  // --- 'message' kind ---

  it('should_map_message_when_raw_is_Message_with_contextId', () => {
    const raw = makeMessage('你好', 'ctx-999')
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('message')
    if (result.kind !== 'message') return
    expect(result.messageId).toBe('msg-001')
    expect(result.contextId).toBe('ctx-999')
    expect(result.text).toBe('你好')
    expect(result.ts).toBe(FIXED_TS)
  })

  it('should_not_include_contextId_key_when_message_has_no_contextId', () => {
    // exactOptionalPropertyTypes：无 contextId 时 key 不应存在
    const raw = makeMessage('无上下文消息')
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('message')
    expect('contextId' in result).toBe(false)
  })

  it('should_concatenate_text_parts_and_ignore_non_text_parts_when_message_has_mixed_parts', () => {
    const raw: Message = {
      kind: 'message',
      messageId: 'msg-003',
      role: 'agent',
      // 混合 parts：text + file（非 text 忽略）
      parts: [
        { kind: 'text', text: '文本部分' },
        { kind: 'file', file: { name: 'test.txt', mimeType: 'text/plain' } } as unknown as { kind: 'text'; text: string },
        { kind: 'text', text: '结尾' },
      ],
    }
    const result = mapToA2AEvent(raw, FIXED_TS)

    expect(result.kind).toBe('message')
    if (result.kind !== 'message') return
    expect(result.text).toBe('文本部分结尾')
  })
})

// ─── a2aEventToSubagentEvent 测试 ─────────────────────────────────────────────

const CTX = { agentId: 'agent-001', parentToolCallId: 'tcid-001', name: '远端工作 Agent' }

describe('a2aEventToSubagentEvent', () => {
  it('should_return_null_when_event_is_task_created', () => {
    const evt: A2AEvent = {
      kind: 'task-created',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'submitted',
      ts: FIXED_TS,
    }
    expect(a2aEventToSubagentEvent(evt, CTX)).toBeNull()
  })

  it('should_return_subagent_progress_when_status_is_working', () => {
    const evt: A2AEvent = {
      kind: 'status',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'working',
      final: false,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_progress')
    if (result.type !== 'subagent_progress') return
    expect(result.agentId).toBe('agent-001')
    expect(result.name).toBe('远端工作 Agent')
    expect(result.agentType).toBe('a2a-remote')
  })

  it('should_return_subagent_progress_with_message_in_description_when_status_has_message', () => {
    const evt: A2AEvent = {
      kind: 'status',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'working',
      message: '正在处理中...',
      final: false,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_progress')
    if (result.type !== 'subagent_progress') return
    expect(result.description).toContain('正在处理中...')
  })

  it('should_return_subagent_progress_when_status_is_input_required', () => {
    const evt: A2AEvent = {
      kind: 'status',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'input-required',
      message: '请提供输入',
      final: false,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_progress')
  })

  it('should_return_subagent_done_with_success_true_when_status_is_completed', () => {
    const evt: A2AEvent = {
      kind: 'status',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'completed',
      message: '任务完成输出',
      final: true,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_done')
    if (result.type !== 'subagent_done') return
    expect(result.success).toBe(true)
    expect(result.output).toBe('任务完成输出')
  })

  it('should_return_subagent_done_with_success_false_when_status_is_failed', () => {
    const evt: A2AEvent = {
      kind: 'status',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'failed',
      message: '执行失败',
      final: true,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_done')
    if (result.type !== 'subagent_done') return
    expect(result.success).toBe(false)
    expect(result.output).toBe('执行失败')
  })

  it('should_return_subagent_done_with_empty_output_when_completed_has_no_message', () => {
    const evt: A2AEvent = {
      kind: 'status',
      taskId: 'task-001',
      contextId: 'ctx-001',
      state: 'completed',
      final: true,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_done')
    if (result.type !== 'subagent_done') return
    expect(result.output).toBe('')
  })

  it('should_return_subagent_progress_with_artifact_name_in_description_when_event_is_artifact', () => {
    const artifact: Artifact = {
      artifactId: 'art-001',
      name: 'output.md',
      parts: [{ kind: 'text', text: '内容' }],
    }
    const evt: A2AEvent = {
      kind: 'artifact',
      taskId: 'task-001',
      contextId: 'ctx-001',
      artifact,
      lastChunk: true,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_progress')
    if (result.type !== 'subagent_progress') return
    expect(result.description).toContain('output.md')
  })

  it('should_return_subagent_progress_with_artifact_id_when_artifact_has_no_name', () => {
    const artifact: Artifact = {
      artifactId: 'art-002',
      parts: [{ kind: 'text', text: '匿名产物' }],
    }
    const evt: A2AEvent = {
      kind: 'artifact',
      taskId: 'task-001',
      contextId: 'ctx-001',
      artifact,
      lastChunk: false,
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_progress')
    if (result.type !== 'subagent_progress') return
    expect(result.description).toContain('art-002')
  })

  it('should_return_subagent_progress_with_text_as_description_when_event_is_message', () => {
    const evt: A2AEvent = {
      kind: 'message',
      messageId: 'msg-001',
      text: '远端直接回复了一条消息',
      ts: FIXED_TS,
    }
    const result = a2aEventToSubagentEvent(evt, CTX)

    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.type).toBe('subagent_progress')
    if (result.type !== 'subagent_progress') return
    expect(result.description).toContain('远端直接回复了一条消息')
  })
})

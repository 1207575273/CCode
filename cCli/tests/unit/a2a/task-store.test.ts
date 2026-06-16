// tests/unit/a2a/task-store.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyTaskEvent,
  getStoredTask,
  registerTaskController,
  cancelStoredTask,
  reapExpiredTasks,
  resetTaskStore,
  TASK_TTL_MS,
} from '../../../src/a2a/task-store.js'
import type { A2AStreamEvent } from '../../../src/a2a/types.js'

const taskCreated = (id = 't1', state = 'submitted'): A2AStreamEvent =>
  ({ kind: 'task', id, contextId: 'c1', status: { state, timestamp: '0' }, history: [] } as A2AStreamEvent)
const statusUpdate = (taskId: string, state: string, final = false): A2AStreamEvent =>
  ({ kind: 'status-update', taskId, contextId: 'c1', status: { state, timestamp: '0' }, final } as A2AStreamEvent)
const artifactUpdate = (taskId: string, artifactId: string): A2AStreamEvent =>
  ({ kind: 'artifact-update', taskId, contextId: 'c1', artifact: { artifactId, name: 'r.txt', parts: [{ kind: 'text', text: 'x' }] }, lastChunk: true } as A2AStreamEvent)

describe('task-store', () => {
  beforeEach(() => resetTaskStore())

  it('should_return_undefined_for_unknown_task', () => {
    expect(getStoredTask('nope')).toBeUndefined()
  })

  it('should_create_task_snapshot_on_task_event', () => {
    applyTaskEvent(taskCreated('t1', 'submitted'))
    const t = getStoredTask('t1')
    expect(t).toMatchObject({ kind: 'task', id: 't1', contextId: 'c1', status: { state: 'submitted' } })
  })

  it('should_advance_state_on_status_update', () => {
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(statusUpdate('t1', 'working'))
    expect(getStoredTask('t1')!.status.state).toBe('working')
  })

  it('should_accumulate_artifacts', () => {
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(artifactUpdate('t1', 'a1'))
    applyTaskEvent(artifactUpdate('t1', 'a2'))
    expect(getStoredTask('t1')!.artifacts).toHaveLength(2)
  })

  it('should_freeze_terminal_state_against_later_updates', () => {
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(statusUpdate('t1', 'completed', true))
    // 终态后再来事件应被忽略（A2A 协议：终态不可变）
    applyTaskEvent(statusUpdate('t1', 'working'))
    expect(getStoredTask('t1')!.status.state).toBe('completed')
  })

  it('should_cancel_running_task_and_abort_controller', () => {
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(statusUpdate('t1', 'working'))
    const controller = new AbortController()
    registerTaskController('t1', controller)

    const result = cancelStoredTask('t1')
    expect(result).toBe('canceled')
    expect(controller.signal.aborted).toBe(true)
    expect(getStoredTask('t1')!.status.state).toBe('canceled')
  })

  it('should_report_not_found_when_cancel_unknown', () => {
    expect(cancelStoredTask('ghost')).toBe('not-found')
  })

  it('should_report_not_cancelable_when_already_terminal', () => {
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(statusUpdate('t1', 'completed', true))
    expect(cancelStoredTask('t1')).toBe('not-cancelable')
  })

  it('should_reap_terminal_tasks_past_ttl', () => {
    let now = 1_000_000
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(statusUpdate('t1', 'completed', true), now) // 终态时间记在 now
    reapExpiredTasks(now)
    expect(getStoredTask('t1')).toBeDefined() // 未过期

    now += TASK_TTL_MS + 1
    reapExpiredTasks(now)
    expect(getStoredTask('t1')).toBeUndefined() // 过期清理
  })

  it('should_not_reap_running_task', () => {
    let now = 1_000_000
    applyTaskEvent(taskCreated('t1'))
    applyTaskEvent(statusUpdate('t1', 'working'))
    now += TASK_TTL_MS * 10
    reapExpiredTasks(now)
    expect(getStoredTask('t1')).toBeDefined()
  })
})

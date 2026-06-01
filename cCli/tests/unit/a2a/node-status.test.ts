// tests/unit/a2a/node-status.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setLocalA2ANode,
  clearLocalA2ANode,
  getLocalA2ANode,
  recordInboundStart,
  recordInboundEnd,
  getInboundActivity,
  resetInboundActivity,
  INBOUND_LOG_MAX,
} from '../../../src/a2a/node-status.js'

describe('node-status A2A 节点状态', () => {
  beforeEach(() => {
    clearLocalA2ANode()
    resetInboundActivity()
  })

  it('should_return_null_when_not_a_node', () => {
    expect(getLocalA2ANode()).toBeNull()
  })

  it('should_store_and_read_node_status', () => {
    setLocalA2ANode({ port: 9801, baseUrl: 'http://127.0.0.1:9801', projectName: 'cCli' })
    expect(getLocalA2ANode()).toEqual({ port: 9801, baseUrl: 'http://127.0.0.1:9801', projectName: 'cCli' })
  })
})

describe('node-status inbound 活动记录', () => {
  beforeEach(() => {
    resetInboundActivity()
  })

  it('should_be_empty_initially', () => {
    expect(getInboundActivity()).toEqual({ active: 0, recent: [] })
  })

  it('should_record_running_task_on_start', () => {
    recordInboundStart({ taskId: 't1', messagePreview: '报告 cwd', startedAt: '2026-06-01T00:00:00.000Z' })

    const activity = getInboundActivity()
    expect(activity.active).toBe(1)
    expect(activity.recent).toHaveLength(1)
    expect(activity.recent[0]).toMatchObject({
      taskId: 't1',
      messagePreview: '报告 cwd',
      state: 'running',
      startedAt: '2026-06-01T00:00:00.000Z',
    })
  })

  it('should_carry_caller_when_provided', () => {
    recordInboundStart({
      taskId: 't1',
      messagePreview: 'hi',
      startedAt: '2026-06-01T00:00:00.000Z',
      caller: { port: 54751, projectName: 'web' },
    })
    expect(getInboundActivity().recent[0]!.caller).toEqual({ port: 54751, projectName: 'web' })
  })

  it('should_mark_completed_and_drop_active_on_end', () => {
    recordInboundStart({ taskId: 't1', messagePreview: 'hi', startedAt: '2026-06-01T00:00:00.000Z' })
    recordInboundEnd('t1', { state: 'completed', durationMs: 1200, endedAt: '2026-06-01T00:00:01.200Z' })

    const activity = getInboundActivity()
    expect(activity.active).toBe(0)
    expect(activity.recent[0]).toMatchObject({
      taskId: 't1',
      state: 'completed',
      durationMs: 1200,
      endedAt: '2026-06-01T00:00:01.200Z',
    })
  })

  it('should_mark_failed_on_end', () => {
    recordInboundStart({ taskId: 't1', messagePreview: 'hi', startedAt: '2026-06-01T00:00:00.000Z' })
    recordInboundEnd('t1', { state: 'failed', durationMs: 500, endedAt: '2026-06-01T00:00:00.500Z' })
    expect(getInboundActivity().recent[0]!.state).toBe('failed')
  })

  it('should_ignore_end_for_unknown_task', () => {
    recordInboundEnd('ghost', { state: 'completed', durationMs: 1, endedAt: '2026-06-01T00:00:00.001Z' })
    expect(getInboundActivity()).toEqual({ active: 0, recent: [] })
  })

  it('should_list_recent_newest_first', () => {
    recordInboundStart({ taskId: 't1', messagePreview: 'first', startedAt: '2026-06-01T00:00:00.000Z' })
    recordInboundStart({ taskId: 't2', messagePreview: 'second', startedAt: '2026-06-01T00:00:01.000Z' })
    const recent = getInboundActivity().recent
    expect(recent[0]!.taskId).toBe('t2')
    expect(recent[1]!.taskId).toBe('t1')
  })

  it('should_bound_log_to_max_keeping_newest', () => {
    const total = INBOUND_LOG_MAX + 5
    for (let i = 0; i < total; i++) {
      recordInboundStart({ taskId: `t${i}`, messagePreview: `m${i}`, startedAt: `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z` })
    }
    const recent = getInboundActivity().recent
    expect(recent).toHaveLength(INBOUND_LOG_MAX)
    // 最新的应保留，最老的被挤出
    expect(recent[0]!.taskId).toBe(`t${total - 1}`)
    expect(recent.some((t) => t.taskId === 't0')).toBe(false)
  })
})

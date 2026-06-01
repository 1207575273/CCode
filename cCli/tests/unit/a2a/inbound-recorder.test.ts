// tests/unit/a2a/inbound-recorder.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import { recordInbound, previewMessage } from '../../../src/a2a/inbound-recorder.js'
import { getInboundActivity, resetInboundActivity } from '../../../src/a2a/node-status.js'
import type { A2AStreamEvent } from '../../../src/a2a/types.js'

/** 构造一个 yield 给定事件序列的异步流 */
async function* streamOf(...events: A2AStreamEvent[]): AsyncGenerator<A2AStreamEvent> {
  for (const e of events) yield e
}

/** 构造一个 yield 若干事件后抛错的流 */
async function* throwingStream(...events: A2AStreamEvent[]): AsyncGenerator<A2AStreamEvent> {
  for (const e of events) yield e
  throw new Error('boom')
}

const completedStream = (): A2AStreamEvent[] => [
  { kind: 'task', id: 't1', contextId: 'c1', status: { state: 'submitted', timestamp: '0' }, history: [] } as A2AStreamEvent,
  { kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'working', timestamp: '0' }, final: false } as A2AStreamEvent,
  { kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'completed', timestamp: '0' }, final: true } as A2AStreamEvent,
]

const failedStream = (): A2AStreamEvent[] => [
  { kind: 'task', id: 't1', contextId: 'c1', status: { state: 'submitted', timestamp: '0' }, history: [] } as A2AStreamEvent,
  { kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'failed', timestamp: '0' }, final: true } as A2AStreamEvent,
]

/** 消费整个流 */
async function drain(gen: AsyncGenerator<A2AStreamEvent>): Promise<A2AStreamEvent[]> {
  const out: A2AStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('recordInbound 包装流记录被调活动', () => {
  beforeEach(() => {
    resetInboundActivity()
  })

  it('should_record_start_then_completed', async () => {
    let t = 1000
    const now = () => t
    const gen = recordInbound(
      { taskId: 't1', message: '报告 cwd 与 PID' },
      streamOf(...completedStream()),
      now,
    )
    // 拿到第一个事件时已记录 start（状态 running）
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(getInboundActivity().active).toBe(1)

    t = 2200 // 模拟耗时
    await drain(gen as AsyncGenerator<A2AStreamEvent>)

    const activity = getInboundActivity()
    expect(activity.active).toBe(0)
    expect(activity.recent[0]).toMatchObject({
      taskId: 't1',
      state: 'completed',
      durationMs: 1200,
    })
  })

  it('should_pass_through_all_events_unchanged', async () => {
    const events = completedStream()
    const out = await drain(recordInbound({ taskId: 't1', message: 'hi' }, streamOf(...events)))
    expect(out).toEqual(events)
  })

  it('should_record_failed_when_final_status_failed', async () => {
    const out = await drain(recordInbound({ taskId: 't1', message: 'hi' }, streamOf(...failedStream())))
    expect(out).toHaveLength(2)
    expect(getInboundActivity().recent[0]!.state).toBe('failed')
  })

  it('should_record_failed_and_rethrow_when_stream_throws', async () => {
    let t = 0
    const now = () => (t += 100)
    const gen = recordInbound({ taskId: 't1', message: 'hi' }, throwingStream(...completedStream().slice(0, 1)), now)
    await expect(drain(gen)).rejects.toThrow('boom')
    expect(getInboundActivity().recent[0]!.state).toBe('failed')
    expect(getInboundActivity().active).toBe(0)
  })

  it('should_carry_caller_into_record', async () => {
    await drain(recordInbound(
      { taskId: 't1', message: 'hi', caller: { port: 54751, projectName: 'web' } },
      streamOf(...completedStream()),
    ))
    expect(getInboundActivity().recent[0]!.caller).toEqual({ port: 54751, projectName: 'web' })
  })
})

describe('previewMessage 截断', () => {
  it('should_collapse_whitespace_and_keep_short', () => {
    expect(previewMessage('  报告   cwd \n PID ')).toBe('报告 cwd PID')
  })

  it('should_truncate_long_message_with_ellipsis', () => {
    const long = 'a'.repeat(100)
    const result = previewMessage(long)
    expect(result.length).toBeLessThanOrEqual(51) // 50 + 省略号
    expect(result.endsWith('…')).toBe(true)
  })
})

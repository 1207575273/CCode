// tests/unit/a2a/server-executor.test.ts

import { describe, it, expect } from 'vitest'
import { executeA2ATask, collectA2ATask, type RunLoopFn } from '../../../src/a2a/server-executor.js'
import type { AgentEvent } from '@core/agent-loop.js'
import type { A2AStreamEvent } from '../../../src/a2a/types.js'

const FIXED_NOW = () => 1_700_000_000_000

function fakeLoop(events: AgentEvent[]): RunLoopFn {
  return async function* () {
    for (const e of events) yield e
  }
}

function throwingLoop(msg: string): RunLoopFn {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new Error(msg)
  }
}

async function drain(gen: AsyncGenerator<A2AStreamEvent>): Promise<A2AStreamEvent[]> {
  const out: A2AStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

const baseParams = {
  taskId: 't1',
  contextId: 'c1',
  signal: new AbortController().signal,
  now: FIXED_NOW,
}

describe('executeA2ATask', () => {
  it('should_emit_task_working_artifact_completed_when_loop_produces_text', async () => {
    const events = drainEvents([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'done' },
    ])
    const out = await drain(executeA2ATask({ ...baseParams, message: 'hi', runLoop: fakeLoop(events) }))

    expect(out[0]!.kind).toBe('task')
    expect((out[0] as { status: { state: string } }).status.state).toBe('submitted')
    expect(out[1]!.kind).toBe('status-update')
    expect((out[1] as { status: { state: string } }).status.state).toBe('working')

    const artifact = out.find((e) => e.kind === 'artifact-update')
    expect(artifact).toBeTruthy()
    expect((artifact as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toBe('Hello world')

    const last = out[out.length - 1]!
    expect(last.kind).toBe('status-update')
    expect((last as { status: { state: string }; final: boolean }).status.state).toBe('completed')
    expect((last as { final: boolean }).final).toBe(true)
  })

  it('should_emit_failed_and_no_artifact_when_loop_errors', async () => {
    const events = drainEvents([
      { type: 'text', text: 'partial' },
      { type: 'error', error: '调用失败' },
    ])
    const out = await drain(executeA2ATask({ ...baseParams, message: 'hi', runLoop: fakeLoop(events) }))

    expect(out.some((e) => e.kind === 'artifact-update')).toBe(false)
    const last = out[out.length - 1]!
    expect((last as { status: { state: string } }).status.state).toBe('failed')
    expect((last as { final: boolean }).final).toBe(true)
  })

  it('should_emit_failed_when_loop_throws', async () => {
    const out = await drain(executeA2ATask({ ...baseParams, message: 'hi', runLoop: throwingLoop('boom') }))
    const last = out[out.length - 1]!
    expect((last as { status: { state: string } }).status.state).toBe('failed')
    const msg = (last as { status: { message?: { parts: Array<{ text: string }> } } }).status.message
    expect(msg?.parts[0]!.text).toContain('boom')
  })

  it('should_auto_resolve_permission_requests', async () => {
    let resolved: boolean | undefined
    const permEvent = {
      type: 'permission_request',
      toolName: 'bash',
      resolve: (v: boolean) => { resolved = v },
    } as unknown as AgentEvent
    const events = drainEvents([permEvent, { type: 'text', text: 'ok' }, { type: 'done' }])
    await drain(executeA2ATask({ ...baseParams, message: 'hi', runLoop: fakeLoop(events) }))
    expect(resolved).toBe(true)
  })

  it('should_use_fallback_text_when_no_output', async () => {
    const out = await drain(executeA2ATask({ ...baseParams, message: 'hi', runLoop: fakeLoop(drainEvents([{ type: 'done' }])) }))
    const artifact = out.find((e) => e.kind === 'artifact-update')
    expect((artifact as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('未产出文本')
  })
})

describe('collectA2ATask', () => {
  it('should_collect_stream_into_completed_task_with_artifacts', async () => {
    const events = drainEvents([{ type: 'text', text: 'result text' }, { type: 'done' }])
    const task = await collectA2ATask(executeA2ATask({ ...baseParams, message: 'hi', runLoop: fakeLoop(events) }))
    expect(task.kind).toBe('task')
    expect(task.id).toBe('t1')
    expect(task.contextId).toBe('c1')
    expect(task.status.state).toBe('completed')
    expect(task.artifacts).toHaveLength(1)
    expect((task.artifacts![0]!.parts[0] as { text?: string }).text).toBe('result text')
  })
})

// 把 AgentEvent 字面量数组做一次类型放宽（测试构造，字段非完整）
function drainEvents(events: Array<Record<string, unknown>>): AgentEvent[] {
  return events as unknown as AgentEvent[]
}

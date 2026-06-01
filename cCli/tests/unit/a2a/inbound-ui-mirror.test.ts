// tests/unit/a2a/inbound-ui-mirror.test.ts

import { describe, it, expect } from 'vitest'
import { mirrorInboundToUI, INBOUND_AGENT_TYPE } from '../../../src/a2a/inbound-ui-mirror.js'
import type { AgentEvent } from '../../../src/core/agent-loop.js'
import type { BridgeEvent } from '../../../src/core/event-bus.js'

async function* streamOf(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e
}

async function* throwingStream(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e
  throw new Error('boom')
}

/** 跑完 mirror，返回 (透传的事件, emit 到的 bridge 事件) */
async function run(
  stream: AsyncGenerator<AgentEvent>,
  meta = { agentId: 'a2a-in-1', name: '来自 :54751 的委托', description: '报告 cwd' },
): Promise<{ passed: AgentEvent[]; emitted: BridgeEvent[] }> {
  const emitted: BridgeEvent[] = []
  const passed: AgentEvent[] = []
  for await (const e of mirrorInboundToUI(meta, stream, (ev) => emitted.push(ev))) {
    passed.push(e)
  }
  return { passed, emitted }
}

describe('mirrorInboundToUI', () => {
  it('should_emit_initial_progress_then_done_for_empty_stream', async () => {
    const { emitted } = await run(streamOf({ type: 'done', reason: 'complete' } as AgentEvent))
    expect(emitted[0]).toMatchObject({ type: 'subagent_progress', agentId: 'a2a-in-1', agentType: INBOUND_AGENT_TYPE, turn: 0 })
    const done = emitted.find((e) => e.type === 'subagent_done')
    expect(done).toMatchObject({ type: 'subagent_done', agentId: 'a2a-in-1', success: true })
  })

  it('should_pass_through_all_events_unchanged', async () => {
    const events: AgentEvent[] = [
      { type: 'llm_start' } as AgentEvent,
      { type: 'text', text: 'hi' } as AgentEvent,
      { type: 'done', reason: 'complete' } as AgentEvent,
    ]
    const { passed } = await run(streamOf(...events))
    expect(passed).toEqual(events)
  })

  it('should_emit_text_detail_as_subagent_event', async () => {
    const { emitted } = await run(streamOf({ type: 'text', text: '结果文本' } as AgentEvent))
    const ev = emitted.find((e) => e.type === 'subagent_event')
    expect(ev).toMatchObject({ type: 'subagent_event', agentId: 'a2a-in-1', detail: { kind: 'text', text: '结果文本' } })
  })

  it('should_emit_progress_with_currentTool_and_tool_detail_on_tool_start', async () => {
    const { emitted } = await run(streamOf(
      { type: 'tool_start', toolName: 'bash', toolCallId: 'c1', args: { cmd: 'ls' } } as AgentEvent,
    ))
    const progress = emitted.filter((e) => e.type === 'subagent_progress')
    expect(progress.some((e) => e.type === 'subagent_progress' && e.currentTool === 'bash')).toBe(true)
    const toolEv = emitted.find((e) => e.type === 'subagent_event' && e.detail.kind === 'tool_start')
    expect(toolEv).toMatchObject({ detail: { kind: 'tool_start', toolName: 'bash', toolCallId: 'c1' } })
  })

  it('should_increment_turn_on_llm_start', async () => {
    const { emitted } = await run(streamOf(
      { type: 'llm_start' } as AgentEvent,
      { type: 'llm_start' } as AgentEvent,
    ))
    const progresses = emitted.filter((e) => e.type === 'subagent_progress') as Extract<BridgeEvent, { type: 'subagent_progress' }>[]
    const maxTurn = Math.max(...progresses.map((p) => p.turn))
    expect(maxTurn).toBe(2)
  })

  it('should_mark_done_failed_when_error_event_seen', async () => {
    const { emitted } = await run(streamOf(
      { type: 'error', error: 'oops' } as AgentEvent,
      { type: 'done', reason: 'complete' } as AgentEvent,
    ))
    const ev = emitted.find((e) => e.type === 'subagent_event' && e.detail.kind === 'error')
    expect(ev).toBeDefined()
    const done = emitted.find((e) => e.type === 'subagent_done') as Extract<BridgeEvent, { type: 'subagent_done' }>
    expect(done.success).toBe(false)
  })

  it('should_emit_done_failed_and_rethrow_when_stream_throws', async () => {
    const emitted: BridgeEvent[] = []
    const gen = mirrorInboundToUI(
      { agentId: 'a2a-in-1', name: 'x', description: 'd' },
      throwingStream({ type: 'text', text: 'partial' } as AgentEvent),
      (ev) => emitted.push(ev),
    )
    await expect((async () => { for await (const _ of gen) { /* drain */ } })()).rejects.toThrow('boom')
    const done = emitted.find((e) => e.type === 'subagent_done') as Extract<BridgeEvent, { type: 'subagent_done' }>
    expect(done.success).toBe(false)
  })
})

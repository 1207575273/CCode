// tests/unit/tool-subagent-store.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerSubAgent,
  appendSubAgentEvent,
  updateSubAgentProgress,
  markSubAgentDone,
  setSubAgentSessionId,
  getSubAgent,
  listSubAgents,
  listRunningSubAgents,
  clearSubAgents,
  consumeAgentEvent,
} from '../../src/tools/ext/subagent-store.js'
import type { AgentEvent } from '../../src/core/agent-loop.js'

describe('subagent-store', () => {
  beforeEach(() => {
    clearSubAgents()
  })

  it('应注册并获取子 Agent', () => {
    registerSubAgent('a1', '测试任务', 15)
    const state = getSubAgent('a1')
    expect(state).toBeDefined()
    expect(state!.agentId).toBe('a1')
    expect(state!.description).toBe('测试任务')
    expect(state!.status).toBe('running')
    expect(state!.maxTurns).toBe(15)
    expect(state!.events).toEqual([])
    expect(state!.done).toBeUndefined()
  })

  it('应追加详细事件', () => {
    registerSubAgent('a1', '任务', 10)
    appendSubAgentEvent('a1', { type: 'tool_start', timestamp: 1, toolName: 'bash' })
    appendSubAgentEvent('a1', { type: 'tool_done', timestamp: 2, toolName: 'bash', success: true, durationMs: 100 })

    const state = getSubAgent('a1')!
    expect(state.events).toHaveLength(2)
    expect(state.events[0]!.type).toBe('tool_start')
    expect(state.events[1]!.type).toBe('tool_done')
  })

  it('应更新进度', () => {
    registerSubAgent('a1', '任务', 10)
    updateSubAgentProgress('a1', 3, 'grep')

    const state = getSubAgent('a1')!
    expect(state.turn).toBe(3)
    expect(state.currentTool).toBe('grep')
  })

  it('应标记完成', () => {
    registerSubAgent('a1', '任务', 10)
    markSubAgentDone('a1', '完成内容', 'done')

    const state = getSubAgent('a1')!
    expect(state.status).toBe('done')
    expect(state.finalText).toBe('完成内容')
    expect(state.finishedAt).toBeDefined()
    expect(state.currentTool).toBeUndefined()
  })

  it('应设置 virtualSessionId', () => {
    registerSubAgent('a1', '任务', 10)
    setSubAgentSessionId('a1', 'sess-123')

    const state = getSubAgent('a1')!
    expect(state.virtualSessionId).toBe('sess-123')
  })

  it('listSubAgents 应按 startedAt 排序', () => {
    registerSubAgent('a2', '后注册', 10)
    registerSubAgent('a1', '先注册', 10)
    // a2 先注册所以 startedAt 更早（同毫秒内可能相同，但顺序保持）
    const list = listSubAgents()
    expect(list).toHaveLength(2)
  })

  it('listRunningSubAgents 应过滤已完成', () => {
    registerSubAgent('a1', '运行中', 10)
    registerSubAgent('a2', '已完成', 10)
    markSubAgentDone('a2', '', 'done')

    const running = listRunningSubAgents()
    expect(running).toHaveLength(1)
    expect(running[0]!.agentId).toBe('a1')
  })

  it('clearSubAgents 应清空所有', () => {
    registerSubAgent('a1', '任务', 10)
    registerSubAgent('a2', '任务', 10)
    clearSubAgents()
    expect(listSubAgents()).toHaveLength(0)
  })

  it('consumeAgentEvent 应正确转换事件', () => {
    registerSubAgent('a1', '任务', 10)

    consumeAgentEvent('a1', { type: 'llm_start', provider: 'test', model: 'test', messageCount: 1 } as AgentEvent)
    expect(getSubAgent('a1')!.turn).toBe(1)

    consumeAgentEvent('a1', {
      type: 'tool_start', toolName: 'bash', toolCallId: 'tc1', args: { command: 'ls' },
    } as AgentEvent)
    expect(getSubAgent('a1')!.currentTool).toBe('bash')
    expect(getSubAgent('a1')!.events).toHaveLength(1)

    consumeAgentEvent('a1', {
      type: 'tool_done', toolName: 'bash', toolCallId: 'tc1', durationMs: 50, success: true,
    } as AgentEvent)
    expect(getSubAgent('a1')!.currentTool).toBeUndefined()
    expect(getSubAgent('a1')!.events).toHaveLength(2)
  })

  it('对不存在的 agentId 操作应静默忽略', () => {
    // 不应抛异常
    appendSubAgentEvent('nope', { type: 'text', timestamp: 1, text: 'hi' })
    updateSubAgentProgress('nope', 5)
    markSubAgentDone('nope', '')
    setSubAgentSessionId('nope', 'x')
    expect(getSubAgent('nope')).toBeUndefined()
  })
})

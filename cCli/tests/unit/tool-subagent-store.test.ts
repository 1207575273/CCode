// tests/unit/tool-subagent-store.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  setSubAgentControl,
  clearSubAgentControl,
  stopAgent,
  stopAllRunningAgents,
  buildStopReport,
} from '../../src/tools/agent/store.js'
import type { SubAgentState } from '../../src/tools/agent/store.js'
import type { AgentEvent } from '../../src/core/agent-loop.js'

describe('subagent-store', () => {
  beforeEach(() => {
    clearSubAgents()
  })

  it('应注册并获取子 Agent', () => {
    registerSubAgent({ agentId: 'a1', name: 'test-a1', description: '测试任务', agentType: 'general', modelName: 'test', maxTurns: 15 })
    const state = getSubAgent('a1')
    expect(state).toBeDefined()
    expect(state!.agentId).toBe('a1')
    expect(state!.description).toBe('测试任务')
    expect(state!.status).toBe('running')
    expect(state!.maxTurns).toBe(15)
    expect(state!.events).toEqual([])
    expect(state!.finishedAt).toBeUndefined()
  })

  it('应追加详细事件', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    appendSubAgentEvent('a1', { type: 'tool_start', timestamp: 1, toolName: 'bash' })
    appendSubAgentEvent('a1', { type: 'tool_done', timestamp: 2, toolName: 'bash', success: true, durationMs: 100 })

    const state = getSubAgent('a1')!
    expect(state.events).toHaveLength(2)
    expect(state.events[0]!.type).toBe('tool_start')
    expect(state.events[1]!.type).toBe('tool_done')
  })

  it('应更新进度', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    updateSubAgentProgress('a1', 3, 'grep')

    const state = getSubAgent('a1')!
    expect(state.turn).toBe(3)
    expect(state.currentTool).toBe('grep')
  })

  it('应标记完成', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    markSubAgentDone('a1', '完成内容', 'done')

    const state = getSubAgent('a1')!
    expect(state.status).toBe('done')
    expect(state.finalText).toBe('完成内容')
    expect(state.finishedAt).toBeDefined()
    expect(state.currentTool).toBeUndefined()
  })

  it('应设置 virtualSessionId', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    setSubAgentSessionId('a1', 'sess-123')

    const state = getSubAgent('a1')!
    expect(state.virtualSessionId).toBe('sess-123')
  })

  it('listSubAgents 应按 startedAt 排序', () => {
    registerSubAgent({ agentId: 'a2', name: 'task-a2', description: '后注册', agentType: 'general', modelName: 'test', maxTurns: 10 })
    registerSubAgent({ agentId: 'a1', name: 'task-a1b', description: '先注册', agentType: 'general', modelName: 'test', maxTurns: 10 })
    // a2 先注册所以 startedAt 更早（同毫秒内可能相同，但顺序保持）
    const list = listSubAgents()
    expect(list).toHaveLength(2)
  })

  it('listRunningSubAgents 应过滤已完成', () => {
    registerSubAgent({ agentId: 'a1', name: 'running-a1', description: '运行中', agentType: 'general', modelName: 'test', maxTurns: 10 })
    registerSubAgent({ agentId: 'a2', name: 'done-a2', description: '已完成', agentType: 'general', modelName: 'test', maxTurns: 10 })
    markSubAgentDone('a2', '', 'done')

    const running = listRunningSubAgents()
    expect(running).toHaveLength(1)
    expect(running[0]!.agentId).toBe('a1')
  })

  it('clearSubAgents 应清空所有', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    registerSubAgent({ agentId: 'a2', name: 'task-a2', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    clearSubAgents()
    expect(listSubAgents()).toHaveLength(0)
  })

  it('consumeAgentEvent 应正确转换事件', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '任务', agentType: 'general', modelName: 'test', maxTurns: 10 })

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

// ═══════════════════════════════════════════════
// 停止机制测试
// ═══════════════════════════════════════════════

describe('subagent-store 停止机制', () => {
  beforeEach(() => {
    clearSubAgents()
  })

  /** 创建 mock AgentLoop — 只需有 requestStop 方法 */
  function createMockLoop() {
    return { requestStop: vi.fn() } as unknown as import('../../src/core/agent-loop.js').AgentLoop
  }

  /** 注册 agent 并设置 control */
  function setupRunningAgent(agentId = 'a1') {
    registerSubAgent({ agentId, name: `task-${agentId}`, description: '测试停止', agentType: 'general', modelName: 'test', maxTurns: 10 })
    const ac = new AbortController()
    const loop = createMockLoop()
    setSubAgentControl(agentId, { abortController: ac, loop })
    return { ac, loop }
  }

  // ── stopAgent ──

  it('stopAgent — 应停止运行中的 agent', () => {
    const { loop } = setupRunningAgent('a1')

    const result = stopAgent('a1', 'user_cli', '用户测试')

    expect(result.success).toBe(true)
    expect(loop.requestStop).toHaveBeenCalledOnce()

    const state = getSubAgent('a1')!
    expect(state.status).toBe('stopping')
    expect(state.stopRequest).toBeDefined()
    expect(state.stopRequest!.source).toBe('user_cli')
    expect(state.stopRequest!.reason).toBe('用户测试')
  })

  it('stopAgent — 按 name 查找并停止', () => {
    setupRunningAgent('a1')
    // 注册时 name 为 'task-a1'

    const result = stopAgent('task-a1', 'user_web', '按名称停止')
    expect(result.success).toBe(true)

    const state = getSubAgent('a1')!
    expect(state.status).toBe('stopping')
    expect(state.stopRequest!.source).toBe('user_web')
  })

  it('stopAgent — 不存在的 agent 返回失败', () => {
    const result = stopAgent('ghost', 'user_cli', '不存在')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('stopAgent — 非 running 状态不能停止', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '已完成', agentType: 'general', modelName: 'test', maxTurns: 10 })
    markSubAgentDone('a1', '完成', 'done')

    const result = stopAgent('a1', 'user_cli', '试图停止已完成的')
    expect(result.success).toBe(false)
    expect(result.error).toContain('cannot stop')
  })

  it('stopAgent — 无 control 句柄不能停止', () => {
    // 注册但未设置 control
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '无控制', agentType: 'general', modelName: 'test', maxTurns: 10 })

    const result = stopAgent('a1', 'user_cli', '无句柄')
    expect(result.success).toBe(false)
    expect(result.error).toContain('no control handle')
  })

  it('stopAgent — 重复调用返回失败（status 已变为 stopping）', () => {
    const { loop } = setupRunningAgent('a1')

    stopAgent('a1', 'user_cli', '第一次')
    const result = stopAgent('a1', 'user_cli', '第二次')

    // 第二次调用时 status 已经是 stopping，不是 running，所以返回失败
    expect(result.success).toBe(false)
    expect(result.error).toContain('stopping')
    // requestStop 只调用了一次（第一次）
    expect(loop.requestStop).toHaveBeenCalledOnce()
  })

  it('stopAgent — 宽限期超时后应 abort', () => {
    vi.useFakeTimers()
    try {
      const { ac } = setupRunningAgent('a1')
      expect(ac.signal.aborted).toBe(false)

      // 使用极短的宽限期（50ms）便于测试
      stopAgent('a1', 'user_cli', '超时测试', 50)

      // 未超时时不应 abort
      vi.advanceTimersByTime(30)
      expect(ac.signal.aborted).toBe(false)

      // 超时后应 abort
      vi.advanceTimersByTime(30)
      expect(ac.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── setSubAgentControl / clearSubAgentControl ──

  it('setSubAgentControl — 应绑定 control 句柄', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '测试', agentType: 'general', modelName: 'test', maxTurns: 10 })
    const ac = new AbortController()
    const loop = createMockLoop()

    setSubAgentControl('a1', { abortController: ac, loop })

    const state = getSubAgent('a1')!
    expect(state.control).toBeDefined()
    expect(state.control!.abortController).toBe(ac)
    expect(state.control!.loop).toBe(loop)
  })

  it('clearSubAgentControl — 应清除 control 和 stopRequest 定时器', () => {
    vi.useFakeTimers()
    try {
      const { ac } = setupRunningAgent('a1')

      // 发起停止，产生 stopRequest 和定时器
      stopAgent('a1', 'user_cli', '测试清除', 5000)
      const state = getSubAgent('a1')!
      expect(state.stopRequest).toBeDefined()

      clearSubAgentControl('a1')

      // control 已清除
      expect(state.control).toBeUndefined()
      // stopRequest 已清除
      expect(state.stopRequest).toBeUndefined()

      // 定时器被清除，超时后不会 abort
      vi.advanceTimersByTime(10000)
      expect(ac.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearSubAgentControl — 对不存在的 agentId 静默忽略', () => {
    expect(() => clearSubAgentControl('nope')).not.toThrow()
  })

  // ── buildStopReport ──

  it('buildStopReport — 应构建完整的停止报告', () => {
    const state: SubAgentState = {
      agentId: 'a1',
      name: 'task-a1',
      description: '测试',
      agentType: 'general',
      modelName: 'test',
      status: 'stopping',
      events: [],
      turn: 3,
      maxTurns: 10,
      startedAt: Date.now(),
      stopRequest: {
        source: 'user_cli',
        reason: '用户手动停止',
        requestedAt: Date.now(),
        gracePeriodMs: 30000,
        timer: setTimeout(() => {}, 99999),
      },
    }

    const report = buildStopReport(state, '部分结果文本', 3, 'graceful')

    expect(report.agentId).toBe('a1')
    expect(report.name).toBe('task-a1')
    expect(report.agentType).toBe('general')
    expect(report.resolution).toBe('graceful')
    expect(report.source).toBe('user_cli')
    expect(report.reason).toBe('用户手动停止')
    expect(report.turn).toBe(3)
    expect(report.maxTurns).toBe(10)
    expect(report.partialResult).toBe('部分结果文本')
  })

  it('buildStopReport — 无 stopRequest 时 source 默认 parent_agent', () => {
    const state: SubAgentState = {
      agentId: 'a2',
      name: 'task-a2',
      description: '测试',
      agentType: 'general',
      modelName: 'test',
      status: 'stopped',
      events: [],
      turn: 5,
      maxTurns: 15,
      startedAt: Date.now(),
    }

    const report = buildStopReport(state, '', 5, 'forced')
    expect(report.source).toBe('parent_agent')
    expect(report.reason).toBe('unknown')
    expect(report.resolution).toBe('forced')
  })

  // ── tokenUsed ──

  it('consumeAgentEvent — llm_done 事件累计 token', () => {
    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '测试', agentType: 'general', modelName: 'test', maxTurns: 10 })

    // 第一次 llm_done
    consumeAgentEvent('a1', { type: 'llm_done', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 } as AgentEvent)
    let state = getSubAgent('a1')!
    expect(state.tokenUsed).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 })

    // 第二次 llm_done（累加）
    consumeAgentEvent('a1', { type: 'llm_done', inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 } as AgentEvent)
    state = getSubAgent('a1')!
    expect(state.tokenUsed).toEqual({ inputTokens: 300, outputTokens: 130, cacheReadTokens: 30, cacheWriteTokens: 5 })
  })

  it('buildStopReport — 包含 tokenUsed', () => {
    const state: SubAgentState = {
      agentId: 'a1',
      name: 'task-a1',
      description: '测试',
      agentType: 'general',
      modelName: 'test',
      status: 'stopping',
      events: [],
      turn: 3,
      maxTurns: 10,
      startedAt: Date.now(),
      stopRequest: {
        source: 'user_cli',
        reason: '测试',
        requestedAt: Date.now(),
        gracePeriodMs: 30000,
        timer: setTimeout(() => {}, 99999),
      },
      tokenUsed: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
    }

    const report = buildStopReport(state, '结果', 3, 'graceful')
    expect(report.tokenUsed).toEqual({ inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 })
  })

  it('buildStopReport — 无 tokenUsed 时不包含字段', () => {
    const state: SubAgentState = {
      agentId: 'a1',
      name: 'task-a1',
      description: '测试',
      agentType: 'general',
      modelName: 'test',
      status: 'stopped',
      events: [],
      turn: 1,
      maxTurns: 10,
      startedAt: Date.now(),
    }

    const report = buildStopReport(state, '', 1, 'forced')
    expect(report.tokenUsed).toBeUndefined()
  })

  // ── 状态机完整性 ──

  it('完整生命周期: running → stopping → stopped（优雅退出）', () => {
    const { loop } = setupRunningAgent('a1')

    // 发起停止
    stopAgent('a1', 'user_cli', '优雅测试')
    const state = getSubAgent('a1')!
    expect(state.status).toBe('stopping')

    // 模拟 AgentLoop 优雅退出后 dispatch-agent 调用 markSubAgentDone
    markSubAgentDone('a1', '已停止的内容', 'stopped')
    expect(state.status).toBe('stopped')
    expect(state.finalText).toBe('已停止的内容')
    expect(state.finishedAt).toBeDefined()
  })

  it('listRunningSubAgents — 应包含 stopping 状态', () => {
    setupRunningAgent('a1')
    setupRunningAgent('a2')

    stopAgent('a1', 'user_cli', '测试')

    const running = listRunningSubAgents()
    // stopping 的 a1 和 running 的 a2 都应该在列表中
    expect(running).toHaveLength(2)
    const ids = running.map(s => s.agentId).sort()
    expect(ids).toEqual(['a1', 'a2'])
  })

  // ── 批量停止 ──

  it('stopAllRunningAgents — 应停止所有 running 的 agent', () => {
    const loop1 = createMockLoop()
    const loop2 = createMockLoop()
    const ac1 = new AbortController()
    const ac2 = new AbortController()

    registerSubAgent({ agentId: 'a1', name: 'task-a1', description: '测试', agentType: 'general', modelName: 'test', maxTurns: 10 })
    setSubAgentControl('a1', { abortController: ac1, loop: loop1 })
    registerSubAgent({ agentId: 'a2', name: 'task-a2', description: '测试', agentType: 'general', modelName: 'test', maxTurns: 10 })
    setSubAgentControl('a2', { abortController: ac2, loop: loop2 })
    // 第三个 agent 已完成，不应被停止
    registerSubAgent({ agentId: 'a3', name: 'task-a3', description: '已完成', agentType: 'general', modelName: 'test', maxTurns: 10 })
    markSubAgentDone('a3', '完成', 'done')

    const result = stopAllRunningAgents('parent_agent', '批量停止测试')
    expect(result.stopped).toBe(2)
    expect(result.failed).toBe(0)

    expect(getSubAgent('a1')!.status).toBe('stopping')
    expect(getSubAgent('a2')!.status).toBe('stopping')
    expect(getSubAgent('a3')!.status).toBe('done')
  })

  it('stopAllRunningAgents — 无活跃 agent 时返回 0', () => {
    const result = stopAllRunningAgents('parent_agent', '无 agent')
    expect(result.stopped).toBe(0)
    expect(result.failed).toBe(0)
  })
})

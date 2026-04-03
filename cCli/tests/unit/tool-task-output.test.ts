// tests/unit/tool-task-output.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import { TaskOutputTool } from '../../src/tools/core/task-output.js'
import {
  registerProcess,
  unregisterProcess,
  appendOutput,
  markDone,
  getProcess,
} from '../../src/tools/core/process-tracker.js'
import {
  registerSubAgent,
  appendSubAgentEvent,
  markSubAgentDone,
  clearSubAgents,
} from '../../src/tools/agent/store.js'
import type { ToolContext } from '../../src/tools/core/types.js'

const ctx: ToolContext = { cwd: '/tmp' }

// 用一个不太可能冲突的 PID
const TEST_PID = 99901

describe('TaskOutputTool', () => {
  beforeEach(() => {
    // 清理测试进程
    unregisterProcess(TEST_PID)
    unregisterProcess(TEST_PID + 1)
  })

  it('应拒绝无效 pid', async () => {
    const tool = new TaskOutputTool()
    const result = await tool.execute({ pid: -1 }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('正整数')
  })

  it('应拒绝不存在的 pid', async () => {
    const tool = new TaskOutputTool()
    const result = await tool.execute({ pid: 88888 }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('不在追踪列表中')
  })

  it('应返回运行中进程的已有输出', async () => {
    registerProcess(TEST_PID, 'sleep 100', '/tmp')
    appendOutput(TEST_PID, 'hello ')
    appendOutput(TEST_PID, 'world\n')

    const tool = new TaskOutputTool()
    const result = await tool.execute({ pid: TEST_PID }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('进程仍在运行')
    expect(result.output).toContain('hello world\n')

    // 清理
    unregisterProcess(TEST_PID)
  })

  it('应返回已结束进程的输出和退出码', async () => {
    registerProcess(TEST_PID, 'echo done', '/tmp')
    appendOutput(TEST_PID, 'done\n')
    markDone(TEST_PID, 0)

    const tool = new TaskOutputTool()
    const result = await tool.execute({ pid: TEST_PID }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('进程已结束')
    expect(result.output).toContain('exitCode: 0')
    expect(result.output).toContain('done\n')

    // 清理
    unregisterProcess(TEST_PID)
  })

  it('block 模式应等待进程结束', async () => {
    registerProcess(TEST_PID, 'slow task', '/tmp')
    appendOutput(TEST_PID, 'starting...\n')

    // 50ms 后标记完成
    setTimeout(() => {
      appendOutput(TEST_PID, 'finished!\n')
      markDone(TEST_PID, 0)
    }, 50)

    const tool = new TaskOutputTool()
    const result = await tool.execute({ pid: TEST_PID, block: true, timeout: 5000 }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('进程已结束')
    expect(result.output).toContain('finished!')

    // 清理
    unregisterProcess(TEST_PID)
  })

  it('block 模式超时应返回当前输出', async () => {
    registerProcess(TEST_PID, 'very slow', '/tmp')
    appendOutput(TEST_PID, 'partial output\n')
    // 不调 markDone，模拟一直运行

    const tool = new TaskOutputTool()
    const t0 = Date.now()
    const result = await tool.execute({ pid: TEST_PID, block: true, timeout: 300 }, ctx)
    const elapsed = Date.now() - t0

    expect(result.success).toBe(true)
    expect(result.output).toContain('进程仍在运行')
    expect(result.output).toContain('partial output')
    // 超时应在 300ms 附近，给 200ms 容差
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(600)

    // 清理
    unregisterProcess(TEST_PID)
  })

  it('无输出时应提示暂无输出', async () => {
    registerProcess(TEST_PID, 'quiet', '/tmp')

    const tool = new TaskOutputTool()
    const result = await tool.execute({ pid: TEST_PID }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('暂无输出')

    // 清理
    unregisterProcess(TEST_PID)
  })
})

describe('TaskOutputTool — SubAgent 模式', () => {
  beforeEach(() => {
    clearSubAgents()
  })

  it('应通过 agent_id 读取子 Agent 状态', async () => {
    registerSubAgent({ agentId: 'test-agent', name: 'test', description: '测试任务', agentType: 'general', modelName: 'test', maxTurns: 10 })
    appendSubAgentEvent('test-agent', { type: 'tool_done', timestamp: 1, toolName: 'bash', success: true, durationMs: 50 })
    markSubAgentDone('test-agent', '完成了', 'done')

    const tool = new TaskOutputTool()
    const result = await tool.execute({ agent_id: 'test-agent' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('子 Agent 已完成')
    expect(result.output).toContain('测试任务')
    expect(result.output).toContain('完成了')
  })

  it('应拒绝不存在的 agent_id', async () => {
    const tool = new TaskOutputTool()
    const result = await tool.execute({ agent_id: 'nonexistent' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('不在追踪列表中')
  })

  it('无 pid 无 agent_id 应报错', async () => {
    const tool = new TaskOutputTool()
    const result = await tool.execute({}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('需要提供')
  })
})

describe('process-tracker 输出缓冲', () => {
  beforeEach(() => {
    unregisterProcess(TEST_PID)
  })

  it('appendOutput 应累积输出', () => {
    registerProcess(TEST_PID, 'test', '/tmp')
    appendOutput(TEST_PID, 'a')
    appendOutput(TEST_PID, 'b')
    appendOutput(TEST_PID, 'c')

    const proc = getProcess(TEST_PID)!
    expect(proc.outputChunks.join('')).toBe('abc')
    expect(proc.outputBytes).toBe(3)

    unregisterProcess(TEST_PID)
  })

  it('markDone 应记录退出码', () => {
    registerProcess(TEST_PID, 'test', '/tmp')
    markDone(TEST_PID, 1)

    const proc = getProcess(TEST_PID)!
    expect(proc.done).toBe(true)
    expect(proc.exitCode).toBe(1)

    unregisterProcess(TEST_PID)
  })

  it('对不存在的 pid 操作应静默忽略', () => {
    // 不应抛异常
    appendOutput(99999, 'data')
    markDone(99999, 0)
  })
})

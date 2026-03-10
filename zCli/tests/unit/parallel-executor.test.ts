import { describe, it, expect, vi } from 'vitest'
import { classifyToolCalls, executeSafeToolsInParallel } from '@core/parallel-executor.js'
import { ToolRegistry } from '@tools/registry.js'
import type { ToolCallContent } from '@core/types.js'
import type { AgentEvent } from '@core/agent-loop.js'
import type { Tool, ToolContext } from '@tools/types.js'

// ═══════════════════════════════════════════════
// 辅助工厂
// ═══════════════════════════════════════════════

function makeTool(name: string, dangerous = false, delayMs = 0): Tool {
  return {
    name,
    description: `mock ${name}`,
    parameters: {},
    dangerous,
    execute: async () => {
      if (delayMs > 0) await sleep(delayMs)
      return { success: true, output: `${name} result` }
    },
  }
}

function makeFailingTool(name: string): Tool {
  return {
    name,
    description: `failing ${name}`,
    parameters: {},
    dangerous: false,
    execute: async () => ({ success: false, output: '', error: `${name} failed` }),
  }
}

function makeThrowingTool(name: string): Tool {
  return {
    name,
    description: `throwing ${name}`,
    parameters: {},
    dangerous: false,
    execute: async () => { throw new Error(`${name} threw`) },
  }
}

function makeToolCall(toolName: string, id?: string): ToolCallContent {
  return {
    type: 'tool_call',
    toolCallId: id ?? `id-${toolName}`,
    toolName,
    args: {},
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const ctx: ToolContext = { cwd: '/tmp' }

// ═══════════════════════════════════════════════
// classifyToolCalls
// ═══════════════════════════════════════════════

describe('classifyToolCalls', () => {
  it('将安全工具和危险工具正确分离', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('read_file', false))
    reg.register(makeTool('write_file', true))

    const toolCalls = [makeToolCall('read_file'), makeToolCall('write_file')]
    const { safe, dangerous } = classifyToolCalls(toolCalls, reg)

    expect(safe).toHaveLength(1)
    expect(safe[0]?.toolName).toBe('read_file')
    expect(dangerous).toHaveLength(1)
    expect(dangerous[0]?.toolName).toBe('write_file')
  })

  it('全部为安全工具时 dangerous 为空', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('read_file', false))
    reg.register(makeTool('glob', false))

    const toolCalls = [makeToolCall('read_file'), makeToolCall('glob')]
    const { safe, dangerous } = classifyToolCalls(toolCalls, reg)

    expect(safe).toHaveLength(2)
    expect(dangerous).toHaveLength(0)
  })

  it('全部为危险工具时 safe 为空', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('bash', true))
    reg.register(makeTool('write_file', true))

    const toolCalls = [makeToolCall('bash'), makeToolCall('write_file')]
    const { safe, dangerous } = classifyToolCalls(toolCalls, reg)

    expect(safe).toHaveLength(0)
    expect(dangerous).toHaveLength(2)
  })

  it('未注册工具视为危险', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('read_file', false))

    const toolCalls = [makeToolCall('read_file'), makeToolCall('unknown_tool')]
    const { safe, dangerous } = classifyToolCalls(toolCalls, reg)

    expect(safe).toHaveLength(1)
    expect(safe[0]?.toolName).toBe('read_file')
    expect(dangerous).toHaveLength(1)
    expect(dangerous[0]?.toolName).toBe('unknown_tool')
  })

  it('空数组返回两个空组', () => {
    const reg = new ToolRegistry()
    const { safe, dangerous } = classifyToolCalls([], reg)
    expect(safe).toHaveLength(0)
    expect(dangerous).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════
// executeSafeToolsInParallel
// ═══════════════════════════════════════════════

describe('executeSafeToolsInParallel', () => {
  it('空数组立即返回空结果', async () => {
    const reg = new ToolRegistry()
    const onEvent = vi.fn()
    const results = await executeSafeToolsInParallel([], reg, onEvent, ctx)

    expect(results).toHaveLength(0)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('单工具执行并收集 tool_start / tool_done 事件', async () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('read_file'))

    const events: AgentEvent[] = []
    const onEvent = (e: AgentEvent) => events.push(e)

    const results = await executeSafeToolsInParallel(
      [makeToolCall('read_file', 'c1')],
      reg,
      onEvent,
      ctx,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    expect(results[0]?.output).toBe('read_file result')

    const starts = events.filter(e => e.type === 'tool_start')
    const dones = events.filter(e => e.type === 'tool_done')
    expect(starts).toHaveLength(1)
    expect(dones).toHaveLength(1)

    const startEvt = starts[0]
    expect(startEvt?.type === 'tool_start' && startEvt.toolCallId).toBe('c1')

    const doneEvt = dones[0]
    expect(doneEvt?.type === 'tool_done' && doneEvt.success).toBe(true)
  })

  it('多工具执行并按原始顺序返回结果', async () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('tool_a'))
    reg.register(makeTool('tool_b'))
    reg.register(makeTool('tool_c'))

    const events: AgentEvent[] = []
    const toolCalls = [
      makeToolCall('tool_a', 'id-a'),
      makeToolCall('tool_b', 'id-b'),
      makeToolCall('tool_c', 'id-c'),
    ]

    const results = await executeSafeToolsInParallel(toolCalls, reg, e => events.push(e), ctx)

    expect(results).toHaveLength(3)
    expect(results[0]?.toolCallId).toBe('id-a')
    expect(results[1]?.toolCallId).toBe('id-b')
    expect(results[2]?.toolCallId).toBe('id-c')

    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(3)
    expect(events.filter(e => e.type === 'tool_done')).toHaveLength(3)
  })

  it('多工具实际并行执行（时间验证）', async () => {
    const reg = new ToolRegistry()
    // 每个工具执行 80ms，3 个并行应在约 80-200ms 内完成
    reg.register(makeTool('slow_a', false, 80))
    reg.register(makeTool('slow_b', false, 80))
    reg.register(makeTool('slow_c', false, 80))

    const toolCalls = [
      makeToolCall('slow_a'),
      makeToolCall('slow_b'),
      makeToolCall('slow_c'),
    ]

    const start = Date.now()
    const results = await executeSafeToolsInParallel(toolCalls, reg, () => {}, ctx)
    const elapsed = Date.now() - start

    expect(results).toHaveLength(3)
    expect(results.every(r => r.success)).toBe(true)
    // 并行执行：应远小于 3 * 80ms = 240ms
    expect(elapsed).toBeLessThan(220)
  })

  it('失败工具（success: false）正确记录结果', async () => {
    const reg = new ToolRegistry()
    reg.register(makeFailingTool('bad_tool'))

    const events: AgentEvent[] = []
    const results = await executeSafeToolsInParallel(
      [makeToolCall('bad_tool', 'fail-1')],
      reg,
      e => events.push(e),
      ctx,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(false)
    expect(results[0]?.error).toBe('bad_tool failed')

    const doneEvt = events.find(e => e.type === 'tool_done')
    expect(doneEvt?.type === 'tool_done' && doneEvt.success).toBe(false)
  })

  it('抛出异常的工具被捕获，不影响其他工具', async () => {
    const reg = new ToolRegistry()
    reg.register(makeThrowingTool('throw_tool'))
    reg.register(makeTool('ok_tool'))

    const toolCalls = [
      makeToolCall('throw_tool', 'id-throw'),
      makeToolCall('ok_tool', 'id-ok'),
    ]

    const results = await executeSafeToolsInParallel(toolCalls, reg, () => {}, ctx)

    expect(results).toHaveLength(2)
    expect(results[0]?.success).toBe(false)
    expect(results[0]?.error).toContain('throw_tool threw')
    expect(results[1]?.success).toBe(true)
  })

  it('超过 maxParallel 时分批执行', async () => {
    const executionOrder: string[] = []
    const reg = new ToolRegistry()

    // 创建 4 个工具，每个执行 50ms，maxParallel = 2 → 需要 2 批
    for (const name of ['t1', 't2', 't3', 't4']) {
      const toolName = name
      reg.register({
        name: toolName,
        description: `mock ${toolName}`,
        parameters: {},
        dangerous: false,
        execute: async () => {
          await sleep(50)
          executionOrder.push(toolName)
          return { success: true, output: `${toolName} done` }
        },
      })
    }

    const toolCalls = ['t1', 't2', 't3', 't4'].map(n => makeToolCall(n))

    const start = Date.now()
    const results = await executeSafeToolsInParallel(toolCalls, reg, () => {}, ctx, 2)
    const elapsed = Date.now() - start

    expect(results).toHaveLength(4)
    expect(results.every(r => r.success)).toBe(true)
    // 两批各 50ms，总计约 100ms（给 50ms 容差）
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(300)

    // 结果按原始顺序排列
    expect(results[0]?.toolName).toBe('t1')
    expect(results[3]?.toolName).toBe('t4')
  })

  it('resultSummary 超过 200 字符时截断', async () => {
    const longOutput = 'x'.repeat(300)
    const reg = new ToolRegistry()
    reg.register({
      name: 'verbose_tool',
      description: 'verbose',
      parameters: {},
      dangerous: false,
      execute: async () => ({ success: true, output: longOutput }),
    })

    const events: AgentEvent[] = []
    await executeSafeToolsInParallel(
      [makeToolCall('verbose_tool', 'v1')],
      reg,
      e => events.push(e),
      ctx,
    )

    const doneEvt = events.find(e => e.type === 'tool_done')
    if (doneEvt?.type === 'tool_done') {
      expect(doneEvt.resultSummary).toBeDefined()
      expect((doneEvt.resultSummary ?? '').length).toBe(200)
    } else {
      expect.fail('未找到 tool_done 事件')
    }
  })

  it('durationMs 字段为非负数', async () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('timed_tool'))

    const events: AgentEvent[] = []
    await executeSafeToolsInParallel([makeToolCall('timed_tool')], reg, e => events.push(e), ctx)

    const doneEvt = events.find(e => e.type === 'tool_done')
    expect(doneEvt?.type === 'tool_done' && doneEvt.durationMs).toBeGreaterThanOrEqual(0)
  })
})

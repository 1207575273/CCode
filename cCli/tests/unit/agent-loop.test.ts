import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '@core/agent-loop.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { ToolRegistry } from '@tools/core/registry.js'
import type { LLMProvider } from '@providers/provider.js'
import type { StreamChunk } from '@core/types.js'

function makeProvider(chunks: StreamChunk[][]): LLMProvider {
  let callCount = 0
  return {
    name: 'mock',
    protocol: 'openai-compat' as const,
    isModelSupported: () => true,
    countTokens: async () => 0,
    chat: vi.fn().mockImplementation(async function* () {
      const turn = chunks[callCount++] ?? [{ type: 'done' as const }]
      for (const c of turn) yield c
    }),
  }
}

describe('AgentLoop', () => {
  it('纯文本回复 — 直接 yield text + done', async () => {
    const provider = makeProvider([[
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
      { type: 'done' },
    ]])
    const loop = new AgentLoop(provider, new ToolRegistry(), { model: 'mock', provider: 'mock' })
    const events: Array<{ type: string; text?: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'hi' }])) {
      events.push(e)
    }
    expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('hello world')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('工具调用 — 自动执行安全工具并继续', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'file content' }),
    })

    const provider = makeProvider([
      // 第一轮：返回 tool_call
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'foo.ts' } } },
        { type: 'done' },
      ],
      // 第二轮：返回文本
      [{ type: 'text', text: 'done reading' }, { type: 'done' }],
    ])

    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: Array<{ type: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'read foo.ts' }])) {
      events.push(e)
    }
    expect(events.some(e => e.type === 'tool_start')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
    expect(events.some(e => e.type === 'text')).toBe(true)
  })

  it('LLM 调用 — yield llm_start 和 llm_done 事件', async () => {
    const provider = makeProvider([[
      { type: 'text', text: 'hi' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'done' },
    ]])
    const loop = new AgentLoop(provider, new ToolRegistry(), { model: 'mock', provider: 'mock' })
    const events: Array<{ type: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'test' }])) {
      events.push(e)
    }
    expect(events[0]?.type).toBe('llm_start')
    expect(events.some(e => e.type === 'llm_done')).toBe(true)
    const usage = events.find(e => e.type === 'llm_done') as { type: string; inputTokens: number; outputTokens: number }
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
  })

  it('LLM 错误 — yield llm_error 事件', async () => {
    const provider = makeProvider([[
      { type: 'error', error: 'rate limit' },
    ]])
    const loop = new AgentLoop(provider, new ToolRegistry(), { model: 'mock', provider: 'mock' })
    const events: Array<{ type: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'test' }])) {
      events.push(e)
    }
    expect(events.some(e => e.type === 'llm_start')).toBe(true)
    expect(events.some(e => e.type === 'llm_error')).toBe(true)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('工具完成 — tool_done 携带 resultSummary', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'file content here' }),
    })
    const provider = makeProvider([
      [{ type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.ts' } } }, { type: 'done' }],
      [{ type: 'text', text: 'ok' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: Array<{ type: string; resultSummary?: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'read' }])) {
      events.push(e)
    }
    const toolDone = events.find(e => e.type === 'tool_done')
    expect(toolDone?.resultSummary).toBe('file content here')
  })

  it('危险工具 — yield permission_request 并等待 resolve', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'bash', description: '', parameters: {}, dangerous: true,
      execute: async () => ({ success: true, output: 'executed' }),
    })

    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'all done' }, { type: 'done' }],
    ])

    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: Array<{ type: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'run ls' }])) {
      if (e.type === 'permission_request') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e as any).resolve(true)  // 自动允许
      }
      events.push(e)
    }
    expect(events.some(e => e.type === 'permission_request')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
  })

  it('多个安全工具 — 并行执行并产生所有事件', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'glob', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: '*.ts' }),
    })
    registry.register({
      name: 'grep', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'found' }),
    })
    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'glob', args: { pattern: '*.ts' } } },
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c2', toolName: 'grep', args: { pattern: 'TODO' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'found results' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: AgentEvent[] = []
    for await (const e of loop.run([{ role: 'user', content: 'search' }])) {
      events.push(e)
    }
    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(2)
    expect(events.filter(e => e.type === 'tool_done')).toHaveLength(2)
  })

  it('混合安全和危险工具 — 安全并行 + 危险串行', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'content' }),
    })
    registry.register({
      name: 'bash', description: '', parameters: {}, dangerous: true,
      execute: async () => ({ success: true, output: 'output' }),
    })
    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.ts' } } },
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: AgentEvent[] = []
    for await (const e of loop.run([{ role: 'user', content: 'do stuff' }])) {
      if (e.type === 'permission_request') {
        (e as { resolve: (v: boolean) => void }).resolve(true)
      }
      events.push(e)
    }
    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(2)
    expect(events.filter(e => e.type === 'tool_done')).toHaveLength(2)
    expect(events.some(e => e.type === 'permission_request')).toBe(true)

    // 验证执行顺序：安全工具的 tool_done 在危险工具的 tool_start 之前
    const safeDoneIdx = events.findIndex(e => e.type === 'tool_done' && 'toolName' in e && e.toolName === 'read_file')
    const dangerousStartIdx = events.findIndex(e => e.type === 'tool_start' && 'toolName' in e && e.toolName === 'bash')
    expect(safeDoneIdx).toBeLessThan(dangerousStartIdx)
  })

  it('单个安全工具 — 仍然正常执行', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'glob', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: '*.ts' }),
    })
    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'glob', args: {} } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: AgentEvent[] = []
    for await (const e of loop.run([{ role: 'user', content: 'search' }])) {
      events.push(e)
    }
    expect(events.some(e => e.type === 'tool_start')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('parallelTools=false — 回退到串行执行', async () => {
    const registry = new ToolRegistry()
    const callOrder: string[] = []
    registry.register({
      name: 'glob', description: '', parameters: {}, dangerous: false,
      execute: async () => { callOrder.push('glob'); return { success: true, output: 'ok' } },
    })
    registry.register({
      name: 'grep', description: '', parameters: {}, dangerous: false,
      execute: async () => { callOrder.push('grep'); return { success: true, output: 'ok' } },
    })
    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'glob', args: {} } },
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c2', toolName: 'grep', args: {} } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', parallelTools: false })
    for await (const _e of loop.run([{ role: 'user', content: 'search' }])) { /* consume */ }
    expect(callOrder).toEqual(['glob', 'grep'])
  })

  // ═══════════════════════════════════════════════
  // requestStop 检查点测试
  // ═══════════════════════════════════════════════

  it('requestStop — 在 turn 顶部检查点优雅退出', async () => {
    // 第一轮正常执行，第二轮开始前触发停止
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'content' }),
    })
    const provider = makeProvider([
      // 第一轮：工具调用
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.ts' } } },
        { type: 'done' },
      ],
      // 第二轮不会真正执行（stopRequested 在 turn 顶部拦截）
      [{ type: 'text', text: 'should not reach' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })

    const events: AgentEvent[] = []
    const runPromise = (async () => {
      for await (const e of loop.run([{ role: 'user', content: 'read' }])) {
        events.push(e)
        // 工具执行完后触发停止（会在第二轮 turn 顶部被拦截）
        if (e.type === 'tool_done') {
          loop.requestStop()
        }
      }
    })()

    await runPromise

    // 应有 done 事件且 reason 为 stopped
    const doneEvent = events.find(e => e.type === 'done')
    expect(doneEvent).toBeDefined()
    if (doneEvent && 'reason' in doneEvent) {
      expect(doneEvent.reason).toBe('stopped')
    }
    // 不应有第二轮的文本输出
    expect(events.some(e => e.type === 'text' && 'text' in e && e.text === 'should not reach')).toBe(false)
  })

  it('requestStop — 工具执行后检查点退出', async () => {
    // 在第一轮工具执行完后立即停止
    const registry = new ToolRegistry()
    registry.register({
      name: 'glob', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: '*.ts' }),
    })
    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'glob', args: {} } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'after' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', maxTurns: 5 })

    const events: AgentEvent[] = []
    const runPromise = (async () => {
      for await (const e of loop.run([{ role: 'user', content: 'search' }])) {
        events.push(e)
        if (e.type === 'tool_done') {
          loop.requestStop()
        }
      }
    })()

    await runPromise

    // 工具已执行完毕
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
    // 应优雅退出
    const doneEvent = events.find(e => e.type === 'done')
    expect(doneEvent).toBeDefined()
    if (doneEvent && 'reason' in doneEvent) {
      expect(doneEvent.reason).toBe('stopped')
    }
  })

  it('requestStop — 初始 turn 前停止直接退出', async () => {
    // maxTurns=2 但在第一轮开始前就调用 requestStop
    const provider = makeProvider([
      [{ type: 'text', text: 'should not reach' }, { type: 'done' }],
    ])
    const loop = new AgentLoop(provider, new ToolRegistry(), { model: 'mock', provider: 'mock' })

    // 在 run 之前就请求停止
    loop.requestStop()

    const events: AgentEvent[] = []
    for await (const e of loop.run([{ role: 'user', content: 'test' }])) {
      events.push(e)
    }

    // 应该只产生 done 事件
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('done')
    if ('reason' in events[0]!) {
      expect(events[0]!.reason).toBe('stopped')
    }
    // 不应有文本输出
    expect(events.some(e => e.type === 'text')).toBe(false)
  })
})

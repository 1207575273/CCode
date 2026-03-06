import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '@core/agent-loop.js'
import { ToolRegistry } from '@tools/registry.js'
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
    const loop = new AgentLoop(provider, new ToolRegistry(), { model: 'mock' })
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

    const loop = new AgentLoop(provider, registry, { model: 'mock' })
    const events: Array<{ type: string }> = []
    for await (const e of loop.run([{ role: 'user', content: 'read foo.ts' }])) {
      events.push(e)
    }
    expect(events.some(e => e.type === 'tool_start')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
    expect(events.some(e => e.type === 'text')).toBe(true)
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

    const loop = new AgentLoop(provider, registry, { model: 'mock' })
    const events: Array<{ type: string; resolve?: (v: boolean) => void }> = []
    for await (const e of loop.run([{ role: 'user', content: 'run ls' }])) {
      if (e.type === 'permission_request') {
        (e as { type: string; resolve: (v: boolean) => void }).resolve(true)  // 自动允许
      }
      events.push(e)
    }
    expect(events.some(e => e.type === 'permission_request')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
  })
})

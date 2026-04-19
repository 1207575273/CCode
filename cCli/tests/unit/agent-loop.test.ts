import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '@core/agent-loop.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { ToolRegistry } from '@tools/core/registry.js'
import type { LLMProvider } from '@providers/provider.js'
import type { StreamChunk, Message, ToolResultContent } from '@core/types.js'
import type { HookManager } from '@hooks/hook-manager.js'

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

  // ─────────────────────────────────────────────
  // 以下测试为 P0 重构(docs/plans/20260420012229_agent-loop重构评审.md §5.1)前置安全网。
  // 重构 agent-loop 时这些测试必须全绿,是"tool_call/tool_result 成对"、Hook 语义、
  // RepetitionDetector 硬拦截、exit reason 分野等核心行为的回归基线。
  // ─────────────────────────────────────────────

  it('雷区一 — 工具抛异常时 history 仍有对应 tool_result(isError)', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: async () => { throw new Error('disk error') },
    })

    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'x' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'handled' }, { type: 'done' }],
    ])

    const history: Message[] = [{ role: 'user', content: 'read x' }]
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    const events: AgentEvent[] = []
    for await (const e of loop.run(history)) events.push(e)

    // tool_call 必须有对应 tool_result(即便工具抛异常)
    const toolResults = history.flatMap(m =>
      Array.isArray(m.content) ? m.content.filter((c): c is ToolResultContent => typeof c === 'object' && 'type' in c && c.type === 'tool_result') : []
    )
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.toolCallId).toBe('c1')
    expect(toolResults[0]!.isError).toBe(true)
    expect(String(toolResults[0]!.result)).toContain('disk error')

    // tool_done 事件也应 success=false
    const toolDone = events.find(e => e.type === 'tool_done') as { type: string; success: boolean }
    expect(toolDone.success).toBe(false)
  })

  it('RepetitionDetector — 连续 4 次相同参数调用触发 block,工具不再执行', async () => {
    const execSpy = vi.fn(async () => ({ success: true, output: 'ok' }))
    const registry = new ToolRegistry()
    registry.register({
      name: 'write_file', description: '', parameters: {}, dangerous: false,
      execute: execSpy,
    })

    // 让 LLM 连续 5 轮都调同一个 write_file 同样参数(触发 BLOCK_THRESHOLD=4)
    const sameCall = { type: 'tool_call' as const, toolCall: { type: 'tool_call' as const, toolCallId: 'same', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } } }
    const provider = makeProvider([
      [sameCall, { type: 'done' }],
      [sameCall, { type: 'done' }],
      [sameCall, { type: 'done' }],
      [sameCall, { type: 'done' }],  // 第 4 次应被 block
      [{ type: 'text', text: 'stop' }, { type: 'done' }],
    ])

    // parallelTools=false:让工具走串行路径,才能触发 RepetitionDetector
    // (并行路径目前绕过 detector,是 P0-01 要修复的核心 bug,见 agent-loop重构评审.md)
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', parallelTools: false })
    const events: AgentEvent[] = []
    for await (const e of loop.run([{ role: 'user', content: 'repeat' }])) events.push(e)

    // 第 4 次(及之后)应被 block,所以 execute 只被调用 3 次
    expect(execSpy).toHaveBeenCalledTimes(3)
    // 最后一个 tool_done 应带 "循环调用已拦截" 摘要
    const toolDones = events.filter(e => e.type === 'tool_done') as Array<{ type: string; success: boolean; resultSummary?: string }>
    const blocked = toolDones.find(e => e.success === false && e.resultSummary?.includes('循环调用已拦截'))
    expect(blocked).toBeDefined()
  })

  it('PreToolUse Hook block — 工具不执行,history 有 error tool_result', async () => {
    const execSpy = vi.fn(async () => ({ success: true, output: 'should not run' }))
    const registry = new ToolRegistry()
    registry.register({
      name: 'bash', description: '', parameters: {}, dangerous: false,
      execute: execSpy,
    })

    const hookManager = {
      run: vi.fn().mockResolvedValue([{ decision: 'block', reason: 'blocked by policy' }]),
    } as unknown as HookManager

    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'understood' }, { type: 'done' }],
    ])

    const history: Message[] = [{ role: 'user', content: 'run ls' }]
    // parallelTools=false:串行路径才有 Hook;并行路径目前绕过 Hook(P0-01 待修)
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', hookManager, parallelTools: false })
    const events: AgentEvent[] = []
    for await (const e of loop.run(history)) events.push(e)

    // 工具不应被执行
    expect(execSpy).not.toHaveBeenCalled()
    // tool_result 仍必须存在,且是 error + 包含 reason
    const toolResults = history.flatMap(m =>
      Array.isArray(m.content) ? m.content.filter((c): c is ToolResultContent => typeof c === 'object' && 'type' in c && c.type === 'tool_result') : []
    )
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.isError).toBe(true)
    expect(String(toolResults[0]!.result)).toContain('blocked by policy')
  })

  it('PreToolUse Hook modify — 工具收到修改后的 args', async () => {
    // 用闭包捕获工具收到的 args,避免 vi.fn mock.calls 类型推断不精确的问题
    let capturedArgs: Record<string, unknown> | null = null
    const registry = new ToolRegistry()
    registry.register({
      name: 'bash', description: '', parameters: {}, dangerous: false,
      execute: async (args) => {
        capturedArgs = args
        return { success: true, output: 'done' }
      },
    })

    const hookManager = {
      run: vi.fn().mockResolvedValue([{ decision: 'modify', modifiedArgs: { command: 'ls -la' } }]),
    } as unknown as HookManager

    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'done' }],
    ])

    // parallelTools=false:走串行才能触发 Hook
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', hookManager, parallelTools: false })
    for await (const _ of loop.run([{ role: 'user', content: 'run' }])) { /* drain */ }

    // 工具执行时应收到 modifiedArgs 而非原始 args
    expect(capturedArgs).not.toBeNull()
    expect((capturedArgs as unknown as { command: string }).command).toBe('ls -la')
  })

  it('PostToolUse Hook additionalContext — 注入 history + yield post_tool_feedback', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'write_file', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'written' }),
    })

    // PreToolUse 返回空(不 block 不 modify),PostToolUse 返回 additionalContext
    const hookManager = {
      run: vi.fn()
        .mockResolvedValueOnce([])  // PreToolUse
        .mockResolvedValueOnce([{ additionalContext: 'tsc error: missing import' }]),  // PostToolUse
    } as unknown as HookManager

    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 't1', toolName: 'write_file', args: { file_path: 'a.ts', content: 'x' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'fix it' }, { type: 'done' }],
    ])

    const history: Message[] = [{ role: 'user', content: 'write a.ts' }]
    // parallelTools=false:串行路径才有 Hook
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', hookManager, parallelTools: false })
    const events: AgentEvent[] = []
    for await (const e of loop.run(history)) events.push(e)

    // 应 yield post_tool_feedback 事件
    const feedback = events.find(e => e.type === 'post_tool_feedback') as { type: string; feedback: string }
    expect(feedback).toBeDefined()
    expect(feedback.feedback).toContain('tsc error')

    // additionalContext 应注入到 history(tool_result 之后的一条 user string 消息)
    const userStringMsg = history.find(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('PostToolUse feedback')
    )
    expect(userStringMsg).toBeDefined()
  })

  it('max_turns — 超过最大轮次应产生 done.reason=max_turns', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: async () => ({ success: true, output: 'ok' }),
    })

    // 每一轮都返回 tool_call,永远触发下一轮,直到 maxTurns 耗尽
    const infinite = () => [
      { type: 'tool_call' as const, toolCall: { type: 'tool_call' as const, toolCallId: `t${Math.random()}`, toolName: 'read_file', args: { path: 'a' } } },
      { type: 'done' as const },
    ]
    const provider = makeProvider([infinite(), infinite(), infinite(), infinite(), infinite()])

    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', maxTurns: 3 })
    const events: AgentEvent[] = []
    for await (const e of loop.run([{ role: 'user', content: 'loop' }])) events.push(e)

    const done = events.at(-1) as { type: string; reason?: string }
    expect(done.type).toBe('done')
    expect(done.reason).toBe('max_turns')
  })

  // ─────────────────────────────────────────────
  // P0.1 验收用例:并行路径下的护栏一致性
  // 当前(重构前)these tests must fail —— 并行路径绕过 RepetitionDetector / Hook,
  // 这恰好是 P0.1 要修的正确性 bug。P0.1 落地后,把 .skip 去掉,两项应全绿。
  // ─────────────────────────────────────────────

  it.skip('[P0.1 验收] 并行路径下 PreToolUse Hook 也应触发(当前 fail,重构后应过)', async () => {
    const execSpy = vi.fn(async () => ({ success: true, output: 'should not run' }))
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file', description: '', parameters: {}, dangerous: false,
      execute: execSpy,
    })

    const hookManager = {
      run: vi.fn().mockResolvedValue([{ decision: 'block', reason: 'blocked by policy' }]),
    } as unknown as HookManager

    const provider = makeProvider([
      [
        { type: 'tool_call', toolCall: { type: 'tool_call', toolCallId: 't1', toolName: 'read_file', args: { path: 'a' } } },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'done' }],
    ])

    // 不传 parallelTools,默认并行
    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock', hookManager })
    for await (const _ of loop.run([{ role: 'user', content: 'read' }])) { /* drain */ }

    expect(hookManager.run).toHaveBeenCalled()
    expect(execSpy).not.toHaveBeenCalled()
  })

  it.skip('[P0.1 验收] 并行路径下 RepetitionDetector 也应拦截(当前 fail,重构后应过)', async () => {
    const execSpy = vi.fn(async () => ({ success: true, output: 'ok' }))
    const registry = new ToolRegistry()
    registry.register({
      name: 'grep', description: '', parameters: {}, dangerous: false,
      execute: execSpy,
    })

    // 同一轮 LLM 返回 5 个相同的并行 grep 调用,第 4 个及之后应被 detector 拦截
    // (当前并行路径完全绕过 detector,所以 execute 会被调 5 次)
    const sameCallN = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: 'tool_call' as const,
        toolCall: { type: 'tool_call' as const, toolCallId: `p${i}`, toolName: 'grep', args: { pattern: 'x' } },
      }))
    const provider = makeProvider([
      [...sameCallN(5), { type: 'done' }],
      [{ type: 'text', text: 'stop' }, { type: 'done' }],
    ])

    const loop = new AgentLoop(provider, registry, { model: 'mock', provider: 'mock' })
    for await (const _ of loop.run([{ role: 'user', content: 'repeat' }])) { /* drain */ }

    // 重构后期望:前 3 次执行,后 2 次被 block → 总调用 3 次
    expect(execSpy).toHaveBeenCalledTimes(3)
  })

  it('abort — signal.abort 后 chat stream throw,产生 llm_done(abort) 或 error', async () => {
    const controller = new AbortController()
    const provider: LLMProvider = {
      name: 'mock',
      protocol: 'openai-compat',
      isModelSupported: () => true,
      countTokens: async () => 0,
      chat: vi.fn().mockImplementation(async function* () {
        yield { type: 'text', text: 'starting' } satisfies StreamChunk
        // 模拟 signal 中断:抛 AbortError
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }),
    }

    const loop = new AgentLoop(provider, new ToolRegistry(), { model: 'mock', provider: 'mock', signal: controller.signal })
    const events: AgentEvent[] = []
    let thrown: unknown = null
    try {
      for await (const e of loop.run([{ role: 'user', content: 'go' }])) events.push(e)
    } catch (err) {
      thrown = err
    }

    // agent-loop 会重新抛出 abort,且 yield 一个 stopReason='abort' 的 llm_done
    expect(thrown).not.toBeNull()
    const llmDone = events.find(e => e.type === 'llm_done') as { type: string; stopReason: string } | undefined
    expect(llmDone?.stopReason).toBe('abort')
  })
})

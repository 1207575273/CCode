import { describe, it, expect, vi } from 'vitest'
import { DispatchAgentTool } from '@tools/ext/dispatch-agent.js'
import type { ToolContext, ToolResult } from '@tools/core/types.js'
import type { AgentEvent } from '@core/agent-loop.js'
import { ToolRegistry } from '@tools/core/registry.js'
import type { LLMProvider } from '@providers/provider.js'
import type { Tool } from '@tools/core/types.js'

// ═══════════════════════════════════════════════
// Mock 工具
// ═══════════════════════════════════════════════

const mockTool = (name: string, dangerous = false): Tool => ({
  name,
  description: `mock ${name}`,
  parameters: { type: 'object', properties: {}, required: [] },
  dangerous,
  execute: async () => ({ success: true, output: `${name} done` }),
})

// ═══════════════════════════════════════════════
// Mock Provider — 模拟 LLM 返回文本（不调用工具）
// ═══════════════════════════════════════════════

/** mock provider 的公共基础字段 */
const MOCK_PROVIDER_BASE = {
  name: 'mock',
  protocol: 'anthropic' as const,
  countTokens: async () => 0,
  isModelSupported: () => true,
}

function createMockProvider(textReply: string): LLMProvider {
  return {
    ...MOCK_PROVIDER_BASE,
    chat: async function* () {
      yield { type: 'text' as const, text: textReply }
      yield {
        type: 'usage' as const,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      yield { type: 'done' as const }
    },
  } as unknown as LLMProvider
}

/** 创建带工具调用的 mock provider：先调一个工具，再输出文本 */
function createMockProviderWithToolCall(toolName: string, toolArgs: Record<string, unknown>, finalText: string): LLMProvider {
  let callCount = 0
  return {
    ...MOCK_PROVIDER_BASE,
    chat: async function* () {
      callCount++
      if (callCount === 1) {
        // 第一轮：返回工具调用
        yield {
          type: 'tool_call' as const,
          toolCall: { toolCallId: 'tc-1', toolName, args: toolArgs },
        }
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
        yield { type: 'done' as const }
      } else {
        // 第二轮：返回文本
        yield { type: 'text' as const, text: finalText }
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 15, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
        yield { type: 'done' as const }
      }
    },
  } as unknown as LLMProvider
}

// ═══════════════════════════════════════════════
// 辅助：收集 generator 事件
// ═══════════════════════════════════════════════

async function collectStream(
  gen: AsyncGenerator<unknown, ToolResult>,
): Promise<{ events: AgentEvent[]; result: ToolResult }> {
  const events: AgentEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value as AgentEvent)
    next = await gen.next()
  }
  return { events, result: next.value }
}

// ═══════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════

describe('DispatchAgentTool', () => {
  const tool = new DispatchAgentTool()

  it('基本属性正确', () => {
    expect(tool.name).toBe('dispatch_agent')
    expect(tool.dangerous).toBe(false)
    expect(tool.parameters.required).toContain('description')
    expect(tool.parameters.required).toContain('prompt')
  })

  it('prompt 为空时返回错误', async () => {
    const registry = new ToolRegistry()
    registry.register(mockTool('read_file'))
    const ctx: ToolContext = {
      cwd: '/tmp',
      provider: createMockProvider('hello'),
      registry,
      model: 'test-model',
      providerName: 'mock',
    }

    const { result } = await collectStream(
      tool.stream({ description: 'test', prompt: '' }, ctx),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('prompt')
  })

  it('缺少 provider/registry 时返回错误', async () => {
    const ctx: ToolContext = { cwd: '/tmp' }
    const { result } = await collectStream(
      tool.stream({ description: 'test', prompt: 'do something' }, ctx),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('provider')
  })

  it('子 Agent 成功执行并返回文本', async () => {
    const registry = new ToolRegistry()
    registry.register(mockTool('read_file'))
    const provider = createMockProvider('task completed successfully')
    const ctx: ToolContext = {
      cwd: '/tmp',
      provider,
      registry,
      model: 'test-model',
      providerName: 'mock',
    }

    const { events, result } = await collectStream(
      tool.stream({ description: '测试任务', prompt: '请完成测试' }, ctx),
    )

    // 成功返回（output 包含信任标记包装）
    expect(result.success).toBe(true)
    expect(result.output).toContain('task completed successfully')
    expect(result.output).toContain('[Sub-agent completed:')
    expect(result.output).toContain('Do NOT repeat')

    // 应有 subagent_progress 事件（至少一个 llm_start → turn 递增）
    const progressEvents = events.filter(e => e.type === 'subagent_progress')
    expect(progressEvents.length).toBeGreaterThan(0)
  })

  it('子 Agent 调用工具时产生 subagent_progress 事件', async () => {
    const registry = new ToolRegistry()
    registry.register(mockTool('read_file'))
    const provider = createMockProviderWithToolCall('read_file', { path: '/test' }, 'done reading')
    const ctx: ToolContext = {
      cwd: '/tmp',
      provider,
      registry,
      model: 'test-model',
      providerName: 'mock',
    }

    const { events, result } = await collectStream(
      tool.stream({ description: '读取文件', prompt: '请读取 /test 文件' }, ctx),
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('done reading')

    // 应有包含 currentTool 的 progress 事件
    const progressWithTool = events.filter(
      (e): e is Extract<AgentEvent, { type: 'subagent_progress' }> =>
        e.type === 'subagent_progress' && 'currentTool' in e,
    )
    expect(progressWithTool.length).toBeGreaterThan(0)
    expect(progressWithTool[0]!.currentTool).toBe('read_file')
  })

  it('子 Agent 工具集不包含 dispatch_agent（防递归）', async () => {
    const registry = new ToolRegistry()
    registry.register(mockTool('read_file'))
    registry.register(tool) // 注册 dispatch_agent 自身

    const subRegistry = registry.cloneWithout('dispatch_agent')
    expect(subRegistry.has('dispatch_agent')).toBe(false)
    expect(subRegistry.has('read_file')).toBe(true)
  })

  it('execute() fallback 返回最终结果（丢弃中间事件）', async () => {
    const registry = new ToolRegistry()
    registry.register(mockTool('read_file'))
    const provider = createMockProvider('fallback result')
    const ctx: ToolContext = {
      cwd: '/tmp',
      provider,
      registry,
      model: 'test-model',
      providerName: 'mock',
    }

    const result = await tool.execute(
      { description: '测试', prompt: '请执行' },
      ctx,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('fallback result')
  })

  it('llm_done 事件被透传', async () => {
    const registry = new ToolRegistry()
    registry.register(mockTool('read_file'))
    const provider = createMockProvider('hello')
    const ctx: ToolContext = {
      cwd: '/tmp',
      provider,
      registry,
      model: 'test-model',
      providerName: 'mock',
    }

    const { events } = await collectStream(
      tool.stream({ description: 'test', prompt: 'hello' }, ctx),
    )

    const usageEvents = events.filter(e => e.type === 'llm_done')
    expect(usageEvents.length).toBeGreaterThan(0)
  })
})

describe('ToolRegistry.cloneWithout', () => {
  it('克隆 registry 并排除指定工具', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))
    reg.register(mockTool('bash'))
    reg.register(mockTool('dispatch_agent'))

    const cloned = reg.cloneWithout('dispatch_agent')
    expect(cloned.has('read_file')).toBe(true)
    expect(cloned.has('bash')).toBe(true)
    expect(cloned.has('dispatch_agent')).toBe(false)
    expect(cloned.getAll()).toHaveLength(2)
  })

  it('排除多个工具', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))
    reg.register(mockTool('bash'))
    reg.register(mockTool('write_file'))

    const cloned = reg.cloneWithout('bash', 'write_file')
    expect(cloned.getAll()).toHaveLength(1)
    expect(cloned.has('read_file')).toBe(true)
  })

  it('排除不存在的工具不报错', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))

    const cloned = reg.cloneWithout('nonexistent')
    expect(cloned.getAll()).toHaveLength(1)
  })
})

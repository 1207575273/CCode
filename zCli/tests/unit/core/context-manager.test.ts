// tests/unit/core/context-manager.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import {
  contextManager,
  FullReplaceStrategy,
  SummaryWithRecentStrategy,
  ToolResultTrimStrategy,
} from '../../../src/core/context-manager.js'
import { contextTracker } from '../../../src/core/context-tracker.js'
import type { Message } from '../../../src/core/types.js'

// 模拟 history
function makeHistory(count: number, includeToolResults = false): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      msgs.push({ role: 'user', content: `User message ${i}` })
    } else {
      msgs.push({ role: 'assistant', content: `Assistant reply ${i}` })
    }
    if (includeToolResults && i % 3 === 0) {
      msgs.push({ role: 'user', content: `[Tool read_file result]: ${'x'.repeat(500)}` })
    }
  }
  return msgs
}

describe('ContextManager', () => {
  beforeEach(() => {
    contextTracker.configure({ contextWindow: 128_000, outputReserve: 16_384 })
    contextTracker.reset()
    contextManager.setStrategy('full-replace')
  })

  it('应能切换策略', () => {
    expect(contextManager.setStrategy('summary-with-recent')).toBe(true)
    expect(contextManager.getStrategyName()).toBe('summary-with-recent')

    expect(contextManager.setStrategy('nonexistent')).toBe(false)
    expect(contextManager.getStrategyName()).toBe('summary-with-recent')
  })

  it('应列出所有可用策略', () => {
    const strategies = contextManager.getAvailableStrategies()
    expect(strategies).toHaveLength(3)
    expect(strategies.map(s => s.name)).toEqual(['full-replace', 'summary-with-recent', 'tool-trim'])
  })

  it('prepare 不触发 compact 时直接返回原 history', async () => {
    // token 使用率 0%，不触发 auto-compact
    const history = makeHistory(4)
    const mockProvider = {} as any
    const result = await contextManager.prepare(history, mockProvider, { model: 'test' })
    expect(result.compacted).toBe(false)
    expect(result.history).toBe(history) // 引用相同
  })
})

describe('ToolResultTrimStrategy', () => {
  it('应裁剪旧 tool 结果，保留最近 N 个', async () => {
    const strategy = new ToolResultTrimStrategy()
    strategy.keepRecentToolResults = 2

    const history: Message[] = [
      { role: 'user', content: '[Tool read_file result]: old content 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: '[Tool grep result]: old content 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: '[Tool bash result]: recent content 3' },
      { role: 'assistant', content: 'reply 3' },
      { role: 'user', content: '[Tool read_file result]: recent content 4' },
    ]

    contextTracker.update(50_000)
    const result = await strategy.compact(history, {} as any, { model: 'test' })

    // 前 2 个 tool 结果应被裁剪
    expect(result.history[0]!.content).toContain('cleared to save context')
    expect(result.history[2]!.content).toContain('cleared to save context')
    // 后 2 个保留
    expect(result.history[4]!.content).toContain('recent content 3')
    expect(result.history[6]!.content).toContain('recent content 4')
    expect(result.compactedMessageCount).toBe(2)
  })

  it('tool 结果不足 N 个时不裁剪', async () => {
    const strategy = new ToolResultTrimStrategy()
    strategy.keepRecentToolResults = 5

    const history: Message[] = [
      { role: 'user', content: '[Tool read_file result]: content' },
      { role: 'assistant', content: 'reply' },
    ]

    contextTracker.update(50_000)
    const result = await strategy.compact(history, {} as any, { model: 'test' })
    expect(result.compactedMessageCount).toBe(0)
  })
})

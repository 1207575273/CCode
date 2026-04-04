/**
 * context-manager 原子性测试 — 验证裁剪不拆散 tool_call/tool_result 成对关系
 *
 * 雷区一防护：ToolResultTrimStrategy + SummaryWithRecentStrategy
 */

import { describe, it, expect } from 'vitest'
import { ToolResultTrimStrategy, SummaryWithRecentStrategy } from '@core/context-manager.js'
import type { Message } from '@core/types.js'
import type { LLMProvider } from '@providers/provider.js'

// mock provider（tool-trim 不调 LLM，summary-with-recent 会调但我们只测切分逻辑）
const mockProvider = {} as LLMProvider

/** 构造一组完整的工具调用轮次 */
function makeToolRound(callId: string, toolName: string, result: string): Message[] {
  return [
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool_call' as const, toolCallId: callId, toolName, args: {} },
      ],
    },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result' as const, toolCallId: callId, result },
      ],
    },
  ]
}

describe('ToolResultTrimStrategy — 结构化消息适配', () => {
  it('能识别结构化 ToolResultContent 消息', async () => {
    const history: Message[] = [
      { role: 'user', content: '初始请求' },
      ...makeToolRound('call_1', 'bash', 'output1 '.repeat(200)), // 大量输出
      ...makeToolRound('call_2', 'bash', 'output2 '.repeat(200)),
      ...makeToolRound('call_3', 'bash', 'output3'),
    ]

    const strategy = new ToolResultTrimStrategy()
    strategy.keepRecentToolResults = 1

    const result = await strategy.compact(history, mockProvider, { model: 'test' })

    // 应该裁剪了 2 个旧的 tool_result（保留最近 1 个）
    expect(result.compactedMessageCount).toBe(2)

    // 被裁剪的消息内容应包含占位符
    const trimmedMsg = result.history[2]! // 第一个 tool_result
    expect(Array.isArray(trimmedMsg.content)).toBe(true)
    const blocks = trimmedMsg.content as Array<{ type: string; result?: unknown; toolCallId?: string }>
    const toolResult = blocks.find(b => b.type === 'tool_result')
    expect(toolResult).toBeDefined()
    // 内容被替换为占位符
    expect(typeof toolResult!.result).toBe('string')
    expect((toolResult!.result as string)).toContain('cleared to save context')
    // toolCallId 保留（成对关系不断裂）
    expect(toolResult!.toolCallId).toBe('call_1')
  })

  it('最近 N 个 tool_result 不被裁剪', async () => {
    const history: Message[] = [
      { role: 'user', content: '请求' },
      ...makeToolRound('call_1', 'bash', 'old'),
      ...makeToolRound('call_2', 'bash', 'recent'),
    ]

    const strategy = new ToolResultTrimStrategy()
    strategy.keepRecentToolResults = 1

    const result = await strategy.compact(history, mockProvider, { model: 'test' })

    // 只裁剪 1 个旧的
    expect(result.compactedMessageCount).toBe(1)

    // 最近的 tool_result（call_2）内容保持原样
    const lastToolResult = result.history[4]! // call_2 的 tool_result
    const blocks = lastToolResult.content as Array<{ type: string; result?: unknown }>
    const tr = blocks.find(b => b.type === 'tool_result')
    expect(tr!.result).toBe('recent')
  })

  it('兼容旧字符串格式的 tool_result', async () => {
    const history: Message[] = [
      { role: 'user', content: '请求' },
      // 旧格式（从历史 JSONL 恢复）
      { role: 'user', content: '[Tool bash result]: old output' },
      ...makeToolRound('call_1', 'bash', 'new output'),
    ]

    const strategy = new ToolResultTrimStrategy()
    strategy.keepRecentToolResults = 1

    const result = await strategy.compact(history, mockProvider, { model: 'test' })

    // 旧格式也应该被识别并裁剪
    expect(result.compactedMessageCount).toBe(1)
  })

  it('无 tool_result 时不做任何修改', async () => {
    const history: Message[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
    ]

    const strategy = new ToolResultTrimStrategy()
    const result = await strategy.compact(history, mockProvider, { model: 'test' })

    expect(result.compactedMessageCount).toBe(0)
    expect(result.history).toEqual(history)
  })
})

describe('SummaryWithRecentStrategy — 切分原子性', () => {
  it('切分点不会落在 tool_call 和 tool_result 之间', async () => {
    // 构造一个精心设计的场景：预算恰好让切分点落在 assistant(tool_call) 和 user(tool_result) 之间
    const history: Message[] = [
      { role: 'user', content: '初始长请求 '.repeat(100) }, // ~400 chars → ~100 tokens
      ...makeToolRound('call_old', 'bash', '旧结果 '.repeat(100)), // ~400 chars
      { role: 'user', content: '第二个请求' },
      ...makeToolRound('call_new', 'bash', '新结果'),
      { role: 'assistant', content: '最终回答' },
    ]

    const strategy = new SummaryWithRecentStrategy()
    // 设置一个很小的 token 预算，强制切分
    strategy.recentTokenBudget = 200 // 只够保留最后几条

    // 由于 compact 需要调 LLM，我们 mock provider
    const mockCompactProvider = {
      chat: async function* () {
        yield { type: 'text' as const, text: '摘要内容' }
        yield { type: 'done' as const, stopReason: 'end_turn' }
      },
    } as unknown as LLMProvider

    const result = await strategy.compact(history, mockCompactProvider, { model: 'test' })

    // 验证 recentHistory 中不存在孤儿 tool_result（即没有前面的 tool_call）
    const recent = result.history.filter(m => m.role !== 'user' || typeof m.content !== 'string' || !m.content.startsWith('This is a summary'))

    for (let i = 0; i < recent.length; i++) {
      const msg = recent[i]!
      if (!Array.isArray(msg.content)) continue

      for (const block of msg.content) {
        if (typeof block !== 'object' || block === null) continue
        const b = block as { type: string; toolCallId?: string }

        if (b.type === 'tool_result') {
          // 找到 tool_result，验证前面有对应的 tool_call
          let foundCall = false
          for (let j = 0; j < i; j++) {
            const prev = recent[j]!
            if (!Array.isArray(prev.content)) continue
            for (const pb of prev.content) {
              if (typeof pb !== 'object' || pb === null) continue
              const p = pb as { type: string; toolCallId?: string }
              if (p.type === 'tool_call' && p.toolCallId === b.toolCallId) {
                foundCall = true
              }
            }
          }
          expect(foundCall).toBe(true) // 不允许孤儿 tool_result
        }
      }
    }
  })
})

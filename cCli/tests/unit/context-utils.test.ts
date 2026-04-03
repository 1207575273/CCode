import { describe, it, expect } from 'vitest'
import { trimHistoryForSubAgent } from '../../src/tools/agent/context-utils.js'
import type { Message } from '@core/types.js'

function msg(role: Message['role'], content: string): Message {
  return { role, content }
}

function toolCallMsg(): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', toolCallId: 'tc_1', toolName: 'bash', args: { command: 'ls' } }],
  }
}

function toolResultMsg(toolCallId = 'tc_1'): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId, result: 'file1.ts\nfile2.ts' }],
  }
}

describe('trimHistoryForSubAgent', () => {
  it('mode=none 返回空数组', () => {
    const history = [msg('user', 'hello')]
    expect(trimHistoryForSubAgent(history, { mode: 'none' })).toEqual([])
  })

  it('空历史返回空', () => {
    expect(trimHistoryForSubAgent([], { mode: 'trimmed' })).toEqual([])
  })

  it('短历史在预算内原样返回（截断超长内容）', () => {
    const history = [msg('user', '需求'), msg('assistant', '好的'), msg('user', '继续')]
    const result = trimHistoryForSubAgent(history, { mode: 'trimmed', maxMessages: 10 })
    expect(result).toHaveLength(3)
    expect(result[0]!.content).toBe('需求')
  })

  it('超过 maxMessages 时保留首条 user + 最近 N 条', () => {
    const history: Message[] = [
      msg('user', '原始需求'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', 'a2'),
      msg('user', 'u3'),
      msg('assistant', 'a3'),
      msg('user', 'u4'),
    ]
    const result = trimHistoryForSubAgent(history, { mode: 'trimmed', maxMessages: 3 })
    // 首条 user（原始需求）+ 最近 3 条（从 user 起点开始）
    expect(result.length).toBeLessThanOrEqual(5)
    expect(result[0]!.content).toBe('原始需求')
    expect(result[result.length - 1]!.content).toBe('u4')
  })

  it('超过 token 预算时裁剪中间消息', () => {
    // 每条 ~250 token（1000 字符 / 4），5 条 = 1250 token
    const longText = 'a'.repeat(1000)
    const history: Message[] = [
      msg('user', longText),
      msg('assistant', longText),
      msg('user', longText),
      msg('assistant', longText),
      msg('user', longText),
    ]
    const result = trimHistoryForSubAgent(history, { mode: 'trimmed', maxMessages: 10, maxTokenEstimate: 600 })
    // 应该裁剪到 token 预算内
    expect(result.length).toBeLessThan(5)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('超长工具结果被截断', () => {
    const history: Message[] = [
      msg('user', '需求'),
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'tc_1', result: 'x'.repeat(2000) }],
      },
    ]
    const result = trimHistoryForSubAgent(history, { mode: 'trimmed' })
    expect(result).toHaveLength(2)
    const block = (result[1]!.content as any[])[0]
    expect(block.result.length).toBeLessThan(600)
    expect(block.result).toContain('truncated')
  })

  it('不完整的工具调用轮次被截断', () => {
    const history: Message[] = [
      msg('user', '需求'),
      msg('assistant', '回复'),
      msg('user', '继续'),
      toolCallMsg(),
      // 缺少 toolResultMsg() → 不完整
    ]
    const result = trimHistoryForSubAgent(history, { mode: 'trimmed' })
    // 应该截断到 toolCallMsg 之前
    expect(result.every(m => {
      if (m.role !== 'assistant') return true
      const blocks = Array.isArray(m.content) ? m.content : []
      return !blocks.some((b: any) => b.type === 'tool_call')
    })).toBe(true)
  })

  it('完整的工具调用轮次保留', () => {
    const history: Message[] = [
      msg('user', '需求'),
      toolCallMsg(),
      toolResultMsg(),
      msg('assistant', '完成'),
    ]
    const result = trimHistoryForSubAgent(history, { mode: 'trimmed' })
    expect(result).toHaveLength(4)
  })

  it('mode=full 返回全量（截断超长内容）', () => {
    const history: Message[] = [
      msg('user', '需求'),
      msg('assistant', 'x'.repeat(5000)),
    ]
    const result = trimHistoryForSubAgent(history, { mode: 'full' })
    expect(result).toHaveLength(2)
    expect((result[1]!.content as string).length).toBeLessThan(1200)
  })

  it('无 policy 时返回空（默认 none）', () => {
    expect(trimHistoryForSubAgent([msg('user', 'hi')])).toEqual([])
  })
})

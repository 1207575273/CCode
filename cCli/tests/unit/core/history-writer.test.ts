import { describe, it, expect } from 'vitest'
import { HistoryWriter } from '@core/history-writer.js'
import type { Message, ToolCallContent, ToolResultContent } from '@core/types.js'

function mkToolCall(id: string, toolName: string, args: Record<string, unknown> = {}): ToolCallContent {
  return { type: 'tool_call', toolCallId: id, toolName, args }
}

function mkToolResult(id: string, result: string, isError?: boolean): ToolResultContent {
  return {
    type: 'tool_result',
    toolCallId: id,
    result,
    ...(isError ? { isError: true as const } : {}),
  }
}

describe('HistoryWriter', () => {
  describe('appendAssistant', () => {
    it('text + tool_calls 构造 assistant 消息', () => {
      const history: Message[] = [{ role: 'user', content: 'hi' }]
      const writer = new HistoryWriter(history)
      writer.appendAssistant('ok', [mkToolCall('t1', 'read_file', { file_path: 'a.ts' })])

      expect(history).toHaveLength(2)
      const asst = history[1]!
      expect(asst.role).toBe('assistant')
      expect(Array.isArray(asst.content)).toBe(true)
      const content = asst.content as Array<{ type: string }>
      expect(content).toHaveLength(2)
      expect(content[0]).toMatchObject({ type: 'text', text: 'ok' })
      expect(content[1]).toMatchObject({ type: 'tool_call', toolCallId: 't1', toolName: 'read_file' })
    })

    it('空 text + 空 toolCalls 不追加', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [])
      expect(history).toHaveLength(0)
    })

    it('tool_call 的 args 经 summarizeArgs 精简(read_file 保留 file_path)', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [mkToolCall('t1', 'read_file', { file_path: 'a.ts', offset: 10 })])

      const tc = (history[0]!.content as Array<{ type: string; args?: Record<string, unknown> }>)[0]
      expect(tc?.args).toEqual({ file_path: 'a.ts', offset: 10 })
    })

    it('write_file 的 content 被摘要为 content_chars', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      const longContent = 'x'.repeat(1000)
      writer.appendAssistant('', [mkToolCall('t1', 'write_file', { file_path: 'a.ts', content: longContent })])

      const tc = (history[0]!.content as Array<{ type: string; args?: Record<string, unknown> }>)[0]
      expect(tc?.args).toEqual({ file_path: 'a.ts', content_chars: 1000 })
      // 大段 content 不应出现在 history
      expect(JSON.stringify(history)).not.toContain(longContent)
    })

    it('tool_call 登记到 pending,appendToolResult 可消费', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [mkToolCall('t1', 'bash', { command: 'ls' })])
      expect(writer.pendingToolCallIds).toEqual(['t1'])

      writer.appendToolResult(mkToolResult('t1', 'ok'))
      expect(writer.pendingToolCallIds).toEqual([])
    })
  })

  describe('appendToolResult — 成对校验', () => {
    it('对应的 pending tool_call 存在时成功', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [mkToolCall('t1', 'bash', { command: 'ls' })])
      writer.appendToolResult(mkToolResult('t1', 'ok'))

      expect(history).toHaveLength(2)
      expect(history[1]).toMatchObject({
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 't1', result: 'ok' }],
      })
    })

    it('无对应 pending tool_call 时抛出(雷区一硬拦截)', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      expect(() => writer.appendToolResult(mkToolResult('orphan', 'x'))).toThrow(
        /tool_result 'orphan' has no matching pending tool_call/,
      )
    })

    it('同一个 tool_result 不能重复追加', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [mkToolCall('t1', 'bash', { command: 'ls' })])
      writer.appendToolResult(mkToolResult('t1', 'ok'))
      expect(() => writer.appendToolResult(mkToolResult('t1', 'ok again'))).toThrow(
        /tool_result 't1' has no matching pending tool_call/,
      )
    })
  })

  describe('appendToolResults — 批量合并一条消息', () => {
    it('多个 tool_result 合并为一条 user 消息', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [
        mkToolCall('a', 'read_file', {}),
        mkToolCall('b', 'read_file', {}),
        mkToolCall('c', 'read_file', {}),
      ])
      writer.appendToolResults([mkToolResult('a', '1'), mkToolResult('b', '2'), mkToolResult('c', '3')])

      // 应生成 2 条消息:assistant + 1 条合并的 user
      expect(history).toHaveLength(2)
      const userMsg = history[1]!
      expect(userMsg.role).toBe('user')
      expect(Array.isArray(userMsg.content)).toBe(true)
      expect(userMsg.content).toHaveLength(3)
    })

    it('空数组不追加', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendToolResults([])
      expect(history).toHaveLength(0)
    })

    it('其中一个 ID 不在 pending 时整批抛异常', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [mkToolCall('a', 'read_file', {})])
      expect(() =>
        writer.appendToolResults([mkToolResult('a', '1'), mkToolResult('orphan', '2')]),
      ).toThrow(/tool_result 'orphan'/)
    })
  })

  describe('appendSystemNote', () => {
    it('追加 user 字符串消息', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendSystemNote('⚠️ warning')

      expect(history).toHaveLength(1)
      expect(history[0]).toEqual({ role: 'user', content: '⚠️ warning' })
    })

    it('不影响 pending tool_call 状态', () => {
      const history: Message[] = []
      const writer = new HistoryWriter(history)
      writer.appendAssistant('', [mkToolCall('t1', 'bash', { command: 'ls' })])
      writer.appendSystemNote('note')
      expect(writer.pendingToolCallIds).toEqual(['t1'])
    })
  })

  describe('从现有 history 恢复 pending(resume 场景)', () => {
    it('已有 tool_call 但缺 tool_result 时进入 pending', () => {
      const history: Message[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool_call', toolCallId: 'legacy-1', toolName: 'bash', args: {} },
          ],
        },
      ]
      const writer = new HistoryWriter(history)
      expect(writer.pendingToolCallIds).toEqual(['legacy-1'])

      // 可以正常追加 tool_result
      writer.appendToolResult(mkToolResult('legacy-1', 'recovered'))
      expect(writer.pendingToolCallIds).toEqual([])
    })

    it('tool_call / tool_result 配对完整时 pending 为空', () => {
      const history: Message[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', toolCallId: 't1', toolName: 'bash', args: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 't1', result: 'done' }],
        },
      ]
      const writer = new HistoryWriter(history)
      expect(writer.pendingToolCallIds).toEqual([])
    })
  })
})

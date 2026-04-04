/**
 * 消息转换器结构化格式测试 — 覆盖四个雷区的回归防护
 *
 * 雷区一：tool_call/tool_result 成对关系
 * 雷区二：错误信息传回 LLM
 */

import { describe, it, expect } from 'vitest'
import { toLangChainMessages } from '@providers/message-converter.js'
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages'
import type { Message } from '@core/types.js'

describe('toLangChainMessages — 结构化 tool_call/tool_result', () => {
  it('assistant(tool_call) → AIMessage with tool_calls', () => {
    const msgs: Message[] = [
      { role: 'user', content: '查文件' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '让我查一下' },
          { type: 'tool_call', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } },
        ],
      },
    ]
    const result = toLangChainMessages(msgs)
    expect(result).toHaveLength(2)

    const ai = result[1]! as AIMessage
    expect(ai).toBeInstanceOf(AIMessage)
    expect(ai.tool_calls!).toHaveLength(1)
    expect(ai.tool_calls![0]!.id).toBe('call_1')
    expect(ai.tool_calls![0]!.name).toBe('bash')
    expect(ai.tool_calls![0]!.args).toEqual({ command: 'ls' })
    expect(ai.content).toBe('让我查一下')
  })

  it('user(tool_result) → ToolMessage with matching tool_call_id', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', result: 'file1.ts\nfile2.ts' },
        ],
      },
    ]
    const result = toLangChainMessages(msgs)
    expect(result).toHaveLength(1)

    const tm = result[0]! as ToolMessage
    expect(tm).toBeInstanceOf(ToolMessage)
    expect(tm.tool_call_id).toBe('call_1')
    expect(tm.content).toBe('file1.ts\nfile2.ts')
  })

  it('完整轮次：user → assistant(tool_call) → user(tool_result) → assistant(text)', () => {
    const msgs: Message[] = [
      { role: 'user', content: '用户请求' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'call_1', toolName: 'read_file', args: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', result: '文件内容' },
        ],
      },
      { role: 'assistant', content: '分析完成' },
    ]
    const result = toLangChainMessages(msgs)
    expect(result).toHaveLength(4)
    expect(result[0]!).toBeInstanceOf(HumanMessage)
    expect(result[1]!).toBeInstanceOf(AIMessage)
    expect((result[1]! as AIMessage).tool_calls).toHaveLength(1)
    expect(result[2]!).toBeInstanceOf(ToolMessage)
    expect((result[2]! as ToolMessage).tool_call_id).toBe('call_1')
    expect(result[3]!).toBeInstanceOf(AIMessage)
  })

  it('多工具并行：一条 assistant 包含多个 tool_call → 多条 ToolMessage', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'call_a', toolName: 'grep', args: {} },
          { type: 'tool_call', toolCallId: 'call_b', toolName: 'glob', args: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_a', result: 'grep结果' },
          { type: 'tool_result', toolCallId: 'call_b', result: 'glob结果' },
        ],
      },
    ]
    const result = toLangChainMessages(msgs)
    expect(result).toHaveLength(3) // 1 AIMessage + 2 ToolMessages

    const ai = result[0]! as AIMessage
    expect(ai.tool_calls).toHaveLength(2)

    expect(result[1]!).toBeInstanceOf(ToolMessage)
    expect((result[1]! as ToolMessage).tool_call_id).toBe('call_a')
    expect(result[2]!).toBeInstanceOf(ToolMessage)
    expect((result[2]! as ToolMessage).tool_call_id).toBe('call_b')
  })

  it('tool_result 带 isError 时 content 仍正确传递', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_err', result: 'ENOENT: file not found', isError: true },
        ],
      },
    ]
    const result = toLangChainMessages(msgs)
    const tm = result[0]! as ToolMessage
    expect(tm).toBeInstanceOf(ToolMessage)
    expect(tm.content).toBe('ENOENT: file not found')
    expect(tm.tool_call_id).toBe('call_err')
  })

  it('tool_result + 文本混合：文本追加为 HumanMessage', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', result: 'ok' },
          { type: 'text', text: '[PostToolUse feedback]: tsc 检查通过' },
        ],
      },
    ]
    const result = toLangChainMessages(msgs)
    // ToolMessage + HumanMessage（文本部分）
    expect(result).toHaveLength(2)
    expect(result[0]!).toBeInstanceOf(ToolMessage)
    expect(result[1]!).toBeInstanceOf(HumanMessage)
    expect(result[1]!.content).toBe('[PostToolUse feedback]: tsc 检查通过')
  })

  it('assistant 只有 tool_call 没有 text 时 content 为空字符串', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'call_1', toolName: 'bash', args: {} },
        ],
      },
    ]
    const result = toLangChainMessages(msgs)
    const ai = result[0]! as AIMessage
    expect(ai.content).toBe('')
    expect(ai.tool_calls).toHaveLength(1)
  })
})

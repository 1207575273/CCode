import { describe, it, expect } from 'vitest'
import { AskUserQuestionTool } from '@tools/ext/ask-user-question.js'
import type { ToolContext, ToolResult } from '@tools/core/types.js'
import type { AgentEvent } from '@core/agent-loop.js'

const baseCx: ToolContext = { cwd: '/tmp' }

/** 辅助：从 generator 取一步 yield 值（断言为 AgentEvent） */
async function nextYield(gen: AsyncGenerator<unknown, ToolResult>) {
  const r = await gen.next()
  expect(r.done).toBe(false)
  return r.value as AgentEvent
}

/** 辅助：从 generator 取最终 return 值（断言为 ToolResult） */
async function nextReturn(gen: AsyncGenerator<unknown, ToolResult>) {
  const r = await gen.next()
  expect(r.done).toBe(true)
  return r.value as ToolResult
}

describe('AskUserQuestionTool', () => {
  it('元信息正确', () => {
    const tool = new AskUserQuestionTool()
    expect(tool.name).toBe('ask_user_question')
    expect(tool.dangerous).toBe(false)
  })

  it('非交互模式直接返回 error', async () => {
    const tool = new AskUserQuestionTool()
    const ctx: ToolContext = { ...baseCx, nonInteractive: true }
    const args = { questions: [{ key: 'q1', title: 'test', type: 'text' }] }
    const gen = tool.stream(args, ctx)
    const result = await gen.next()
    expect(result.done).toBe(true)
    const val = result.value as ToolResult
    expect(val.success).toBe(false)
    expect(val.error).toBe('not_interactive')
  })

  it('交互模式 yield user_question_request 并等待 resolve', async () => {
    const tool = new AskUserQuestionTool()
    const questions = [
      { key: 'domain', title: '选择领域', type: 'select' as const, options: [{ label: 'SaaS' }] },
    ]
    const gen = tool.stream({ questions }, baseCx)

    const event = await nextYield(gen) as AgentEvent & { type: 'user_question_request' }
    expect(event.type).toBe('user_question_request')
    expect(event.questions).toEqual(questions)
    expect(typeof event.resolve).toBe('function')

    // 模拟用户提交答案
    event.resolve({ cancelled: false, answers: { domain: 'SaaS' } })
    const result = await nextReturn(gen)
    expect(result.success).toBe(true)
    expect(result.output).toContain('SaaS')
    expect(result.output).toContain('选择领域')
  })

  it('用户取消返回 cancelled error', async () => {
    const tool = new AskUserQuestionTool()
    const gen = tool.stream({ questions: [{ key: 'q', title: 'test', type: 'text' }] }, baseCx)

    const event = await nextYield(gen) as AgentEvent & { type: 'user_question_request' }
    event.resolve({ cancelled: true })

    const result = await nextReturn(gen)
    expect(result.success).toBe(false)
    expect(result.error).toBe('cancelled')
  })

  it('空 questions 返回 invalid_args error', async () => {
    const tool = new AskUserQuestionTool()
    const gen = tool.stream({ questions: [] }, baseCx)
    const r = await gen.next()
    expect(r.done).toBe(true)
    const val = r.value as ToolResult
    expect(val.success).toBe(false)
    expect(val.error).toBe('invalid_args')
  })

  it('execute fallback 在非交互模式下返回 error', async () => {
    const tool = new AskUserQuestionTool()
    const ctx: ToolContext = { ...baseCx, nonInteractive: true }
    const result = await tool.execute({ questions: [] }, ctx)
    expect(result.success).toBe(false)
  })

  it('meta 包含 questionCount 和 answered 状态', async () => {
    const tool = new AskUserQuestionTool()
    const questions = [
      { key: 'q1', title: 'Q1', type: 'select' as const, options: [{ label: 'A' }] },
      { key: 'q2', title: 'Q2', type: 'text' as const },
    ]

    // 提交答案
    const gen = tool.stream({ questions }, baseCx)
    const event = await nextYield(gen) as AgentEvent & { type: 'user_question_request' }
    event.resolve({ cancelled: false, answers: { q1: 'A', q2: 'hello' } })
    const result = await nextReturn(gen)
    expect(result.meta).toMatchObject({ type: 'ask_user', questionCount: 2, answered: true })
    // meta 应包含 pairs
    const meta = result.meta as { pairs: Array<{ question: string; answer: string }> }
    expect(meta.pairs).toHaveLength(2)
    expect(meta.pairs[0]).toEqual({ question: 'Q1', answer: 'A' })

    // 取消场景
    const gen2 = tool.stream({ questions }, baseCx)
    const ev2 = await nextYield(gen2) as AgentEvent & { type: 'user_question_request' }
    ev2.resolve({ cancelled: true })
    const result2 = await nextReturn(gen2)
    expect(result2.meta).toEqual({ type: 'ask_user', questionCount: 2, answered: false })
  })
})

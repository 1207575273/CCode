// src/tools/ask-user-question.ts

/**
 * AskUserQuestionTool — 向用户提出多步结构化问题。
 *
 * StreamableTool 实现：
 * - stream(): yield user_question_request 暂停等待，return 用户答案
 * - execute(): fallback，消费 stream() 返回最终结果
 *
 * 非交互模式（pipe）下直接返回 error，不 yield 事件。
 */

import type { ToolContext, ToolResult, StreamableTool } from '../core/types.js'
import type { AgentEvent, UserQuestion, UserQuestionResult } from '@core/agent-loop.js'

export class AskUserQuestionTool implements StreamableTool {
  readonly name = 'ask_user_question'
  readonly description = [
    '向用户提出结构化问题并收集答案，支持单选、多选和文本输入。',
    '',
    '适用场景：',
    '• 需要用户在多个方案中做选择时',
    '• 需要澄清需求或收集偏好时',
    '• 需要用户确认关键决策时',
    '',
    '注意事项：',
    '• 用户可以随时取消（返回 "cancelled" 错误）',
    '• 尽量减少问题数量，避免过多打扰用户',
  ].join('\n')
  readonly parameters = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '问题列表，按顺序逐步展示给用户',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '答案的唯一标识（如 "domain"、"focus"）' },
            title: { type: 'string', description: '展示给用户的问题文本' },
            type: { type: 'string', enum: ['select', 'multiselect', 'text'], description: '问题类型：单选 / 多选 / 文本输入' },
            options: {
              type: 'array',
              description: 'select/multiselect 的选项列表',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项文本' },
                  description: { type: 'string', description: '选项补充说明（可选）' },
                },
                required: ['label'],
              },
            },
            placeholder: { type: 'string', description: '文本输入的占位提示（仅 text 类型）' },
          },
          required: ['key', 'title', 'type'],
        },
      },
    },
    required: ['questions'],
  }
  readonly dangerous = false

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gen = this.stream(args, ctx)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    return next.value
  }

  async *stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<AgentEvent, ToolResult> {
    // 非交互模式直接报错
    if (ctx.nonInteractive) {
      return {
        success: false,
        output: '非交互模式不支持 AskUserQuestion',
        error: 'not_interactive',
      }
    }

    // 解析 questions 参数
    const rawQuestions = args['questions']
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return {
        success: false,
        output: 'questions 参数不能为空',
        error: 'invalid_args',
      }
    }

    const questions = rawQuestions as UserQuestion[]

    // 构建 Promise，yield 事件暂停等待用户回答
    let resolveAnswer!: (result: UserQuestionResult) => void
    const promise = new Promise<UserQuestionResult>(r => { resolveAnswer = r })

    yield {
      type: 'user_question_request',
      questions,
      resolve: resolveAnswer,
    } satisfies AgentEvent

    const result = await promise

    if (result.cancelled) {
      return {
        success: false,
        output: '用户取消了问答',
        error: 'cancelled',
        meta: { type: 'ask_user', questionCount: questions.length, answered: false },
      }
    }

    // 构建可读的问答摘要 + meta 中携带 pairs 供 UI 渲染
    const answers = result.answers ?? {}
    const pairs: Array<{ question: string; answer: string }> = []
    const lines: string[] = ['User answered questions:']

    for (const q of questions) {
      const raw = answers[q.key]
      const answerText = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      pairs.push({ question: q.title, answer: answerText })
      lines.push(`  · ${q.title} → ${answerText}`)
    }

    return {
      success: true,
      output: lines.join('\n'),
      meta: { type: 'ask_user', questionCount: questions.length, answered: true, pairs },
    }
  }
}

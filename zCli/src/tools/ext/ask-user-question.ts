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
  readonly description =
    'Ask the user a series of structured questions (single-select, multi-select, or free text) ' +
    'and collect their answers. Use this when you need to gather specific information from the user ' +
    'in a structured way, such as clarifying requirements, choosing between options, or collecting preferences.\n\n' +
    'The tool presents a multi-step form with Tab navigation between steps. ' +
    'Each step can be a single-select list, multi-select checkboxes, or free text input. ' +
    'The user can cancel at any step, in which case the tool returns an error with "cancelled".'
  readonly parameters = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'List of questions to ask the user, presented as a multi-step form',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Unique key for this answer (e.g., "domain", "focus")' },
            title: { type: 'string', description: 'The question text shown to the user' },
            type: { type: 'string', enum: ['select', 'multiselect', 'text'], description: 'Question type' },
            options: {
              type: 'array',
              description: 'Options for select/multiselect questions',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option text' },
                  description: { type: 'string', description: 'Optional description shown below the label' },
                },
                required: ['label'],
              },
            },
            placeholder: { type: 'string', description: 'Placeholder text for text input questions' },
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

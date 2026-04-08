// src/tools/todo-write.ts

/**
 * TodoWriteTool — 任务规划工具。
 *
 * LLM 调用此工具创建/更新任务列表。
 * 全量覆盖（每次传入完整的 todos 数组）。
 * 对齐 Claude Code CLI 的 TodoWrite：
 *   - activeForm：当前正在进行的动作描述（现在进行时）
 *   - verificationNudgeNeeded：所有任务完成时提示用户验证
 */

import type { Tool, ToolResult, ToolContext } from '../core/types.js'
import { setTodos, getTodos } from './todo-store.js'

export class TodoWriteTool implements Tool {
  readonly name = 'todo_write'
  readonly description = [
    '创建或更新任务计划列表，用于追踪多步骤任务的进度。',
    '',
    '注意事项：',
    '• 每次调用传入完整的任务列表（全量替换，非增量更新）',
    '• 复杂任务开始前先创建计划，每完成一步更新状态',
    '• activeForm 描述当前正在做的事（如"正在读取配置文件"），仅 in_progress 状态有意义',
  ].join('\n')
  readonly dangerous = false
  readonly parameters = {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的任务列表（全量替换上一次的列表）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '任务描述' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态' },
            activeForm: { type: 'string', description: '当前进行中的动作描述（仅 in_progress 时有意义）' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const rawTodos = args['todos']
    if (!Array.isArray(rawTodos)) {
      return { success: false, output: 'todos must be an array' }
    }

    const items = rawTodos.map(t => {
      const raw = t as Record<string, unknown>
      return {
        content: String(raw['content'] ?? ''),
        status: (String(raw['status'] ?? 'pending')) as 'pending' | 'in_progress' | 'completed',
        activeForm: String(raw['activeForm'] ?? ''),
      }
    })

    const { oldTodos, newTodos } = setTodos(items)

    const completed = newTodos.filter(t => t.status === 'completed').length
    const total = newTodos.length
    // 所有任务完成时提示用户验证
    const verificationNudgeNeeded = total > 0 && completed === total

    const output = `Task plan updated: ${completed}/${total} completed.` +
      (verificationNudgeNeeded ? ' All tasks done — please verify the results.' : '') +
      '\n' +
      newTodos.map(t => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
        const active = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : ''
        return `${icon} ${t.content}${active}`
      }).join('\n')

    return {
      success: true,
      output,
      // meta 不使用 ToolResultMeta（todo 数据通过 TodoStore + EventBus 分发，不需要走 meta 渲染通道）
    }
  }
}

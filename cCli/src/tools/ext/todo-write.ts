// src/tools/todo-write.ts

/**
 * TodoWriteTool — 任务规划工具。
 *
 * LLM 调用此工具创建/更新任务列表。
 * 全量覆盖（每次传入完整的 todos 数组）。
 * 不依赖 dispatch_agent — TodoWrite 是 Planning 可视化，Agent 是执行。
 */

import type { Tool, ToolResult, ToolContext } from '../core/types.js'
import { setTodos, getTodos } from './todo-store.js'

export class TodoWriteTool implements Tool {
  readonly name = 'todo_write'
  readonly description =
    'Create or update the task plan. Pass the complete list of tasks with their current status. ' +
    'Use this to track progress on multi-step tasks. Each call replaces the entire list.'
  readonly dangerous = false
  readonly parameters = {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list (replaces previous list)',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status' },
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

    const items = rawTodos.map(t => ({
      content: String((t as Record<string, unknown>)['content'] ?? ''),
      status: (String((t as Record<string, unknown>)['status'] ?? 'pending')) as 'pending' | 'in_progress' | 'completed',
    }))

    setTodos(items)
    const newTodos = getTodos()

    const completed = newTodos.filter(t => t.status === 'completed').length
    const total = newTodos.length

    return {
      success: true,
      output: `Task plan updated: ${completed}/${total} completed.\n` +
        newTodos.map(t => {
          const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
          return `${icon} ${t.content}`
        }).join('\n'),
    }
  }
}

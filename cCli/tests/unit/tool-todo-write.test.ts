import { describe, it, expect, beforeEach } from 'vitest'
import { TodoWriteTool } from '@tools/ext/todo-write.js'
import { getTodos, setTodos, resetTodos } from '@tools/ext/todo-store.js'
import type { ToolContext } from '@tools/core/types.js'

const ctx: ToolContext = { cwd: process.cwd() }
const tool = new TodoWriteTool()

beforeEach(() => { resetTodos() })

describe('TodoWriteTool', () => {
  it('should have correct name and not dangerous', () => {
    expect(tool.name).toBe('todo_write')
    expect(tool.dangerous).toBe(false)
  })

  it('should create todo list', async () => {
    const result = await tool.execute({
      todos: [
        { content: '读取文件', status: 'completed' },
        { content: '分析代码', status: 'in_progress' },
        { content: '写测试', status: 'pending' },
      ],
    }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('1/3')
    expect(getTodos()).toHaveLength(3)
  })

  it('should replace entire list on update', async () => {
    await tool.execute({ todos: [{ content: 'task 1', status: 'pending' }] }, ctx)
    expect(getTodos()).toHaveLength(1)

    await tool.execute({ todos: [
      { content: 'task A', status: 'completed' },
      { content: 'task B', status: 'pending' },
    ] }, ctx)
    expect(getTodos()).toHaveLength(2)
    expect(getTodos()[0]!.content).toBe('task A')
  })

  it('should handle empty array', async () => {
    await tool.execute({ todos: [{ content: 'x', status: 'pending' }] }, ctx)
    const result = await tool.execute({ todos: [] }, ctx)
    expect(result.success).toBe(true)
    expect(getTodos()).toHaveLength(0)
  })

  it('should reject non-array input', async () => {
    const result = await tool.execute({ todos: 'not array' }, ctx)
    expect(result.success).toBe(false)
  })
})

describe('TodoStore', () => {
  it('should reset state', () => {
    setTodos([{ content: 'x', status: 'pending', activeForm: '' }])
    expect(getTodos()).toHaveLength(1)
    resetTodos()
    expect(getTodos()).toHaveLength(0)
  })
})

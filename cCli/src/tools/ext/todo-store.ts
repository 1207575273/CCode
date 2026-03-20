// src/tools/todo-store.ts

/**
 * TodoStore — 任务列表内存状态管理。
 *
 * Session 级生命周期（CLI 退出即清空）。
 * LLM 通过 TodoWrite 工具全量覆盖写入。
 * 通过 EventBus 广播变更给 CLI UI 和 Web。
 */

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

// 模块级状态
let todos: TodoItem[] = []
let idCounter = 0

export function getTodos(): TodoItem[] {
  return [...todos]
}

export function setTodos(newTodos: Omit<TodoItem, 'id'>[]): { oldTodos: TodoItem[]; newTodos: TodoItem[] } {
  const old = [...todos]
  todos = newTodos.map(t => ({
    id: `todo-${++idCounter}`,
    content: t.content,
    status: t.status,
  }))
  return { oldTodos: old, newTodos: [...todos] }
}

export function resetTodos(): void {
  todos = []
  idCounter = 0
}

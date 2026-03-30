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
  /** 当前正在进行的动作描述（现在进行时），如 "正在读取配置文件" */
  activeForm: string
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
    activeForm: t.activeForm ?? '',
  }))
  return { oldTodos: old, newTodos: [...todos] }
}

export function resetTodos(): void {
  todos = []
  idCounter = 0
}

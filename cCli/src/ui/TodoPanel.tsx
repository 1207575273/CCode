// src/ui/TodoPanel.tsx

/**
 * TodoPanel — CLI 端任务计划面板。
 *
 * 在 todo_write 工具执行后，由 App.tsx 渲染于对话区下方、输入框上方。
 * 全部任务完成时自动隐藏（不再占据悬浮层）。
 */

import React from 'react'
import { Box, Text } from 'ink'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

interface Props {
  todos: TodoItem[]
}

/** 是否还有未完成的任务 */
export function hasPendingTodos(todos: TodoItem[]): boolean {
  return todos.length > 0 && todos.some(t => t.status !== 'completed')
}

export function TodoPanel({ todos }: Props) {
  if (todos.length === 0) return null

  const completed = todos.filter(t => t.status === 'completed').length

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text dimColor>📋 任务计划 ({completed}/{todos.length} 完成)</Text>
      {todos.map((t, i) => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
        const color: 'green' | 'yellow' | undefined =
          t.status === 'completed' ? 'green' : t.status === 'in_progress' ? 'yellow' : undefined
        const active = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : ''
        return (
          <Box key={t.id} paddingLeft={1}>
            <Text {...(color !== undefined ? { color } : {})}>{icon} {i + 1}. {t.content}{active}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

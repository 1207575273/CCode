// src/ui/TodoPanel.tsx

/**
 * TodoPanel — CLI 端任务计划面板。
 *
 * 在 todo_write 工具执行后，由 App.tsx 渲染于对话区下方、输入框上方。
 * todos 为空时不渲染（隐藏）。
 */

import React from 'react'
import { Box, Text } from 'ink'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

interface Props {
  todos: TodoItem[]
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
        return (
          <Box key={t.id} paddingLeft={1}>
            <Text {...(color !== undefined ? { color } : {})}>{icon} {i + 1}. {t.content}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

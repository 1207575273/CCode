// src/components/TodoPanel.tsx

/**
 * TodoPanel — Web 端任务计划面板。
 *
 * 展示 LLM 通过 todo_write 工具写入的任务列表。
 * 包含进度条和 checkbox 列表，completed 条目加删除线。
 */

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
  const progress = todos.length > 0 ? Math.round((completed / todos.length) * 100) : 0

  return (
    <div className="mx-4 my-2 p-3 bg-elevated border border-border rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-txt-primary">📋 任务计划</span>
        <span className="text-xs text-txt-secondary">{completed}/{todos.length} ({progress}%)</span>
      </div>
      {/* 进度条 */}
      <div className="w-full h-1.5 bg-elevated rounded-full mb-2">
        <div
          className="h-full bg-success rounded-full transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      {/* 任务列表 */}
      <div className="space-y-1">
        {todos.map((t, i) => {
          const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
          const cls =
            t.status === 'completed'
              ? 'text-sm text-txt-secondary line-through'
              : t.status === 'in_progress'
                ? 'text-sm text-yellow-300'
                : 'text-sm text-txt-primary'
          return (
            <div key={t.id} className={cls}>
              {icon} {i + 1}. {t.content}
            </div>
          )
        })}
      </div>
    </div>
  )
}

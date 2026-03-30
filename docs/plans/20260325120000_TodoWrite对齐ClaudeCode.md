# TodoWrite 对齐 Claude Code CLI

> 日期: 2026-03-25
> 状态: 已完成

---

## 一、背景

调研发现 Claude Code CLI 也没有显式 Task 系统（TaskCreate/TaskUpdate 等是 Claude.ai Web 版功能），
它和 CCode 一样只有一个 `todo_write` 工具。差距主要在两个字段：

| 维度 | Claude Code CLI | CCode（改动前） |
|------|----------------|-----------------|
| `activeForm` | ✅ 当前动作描述 | ❌ 无 |
| `verificationNudgeNeeded` | ✅ 全部完成时提示验证 | ❌ 无 |
| 全部完成后 UI 行为 | 自动隐藏面板 | ❌ 一直挂着 |

---

## 二、改动

### 2.1 TodoStore（`src/tools/ext/todo-store.ts`）

TodoItem 新增 `activeForm` 字段：
```typescript
interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string  // 新增：当前动作描述（现在进行时）
}
```

### 2.2 TodoWriteTool（`src/tools/ext/todo-write.ts`）

- 参数 schema 新增 `activeForm`（可选）
- description 引导 LLM 使用 activeForm
- 输出格式：in_progress 任务附带 `(activeForm)` 展示
- 全部完成时输出 "All tasks done — please verify the results."

### 2.3 AgentEvent 类型（`src/core/agent-loop.ts`）

`todo_update` 事件类型加 `activeForm` 字段。

### 2.4 useChat（`src/ui/useChat.ts`）

todos 状态类型适配 `activeForm`。

### 2.5 TodoPanel（`src/ui/TodoPanel.tsx`）

- 展示 `activeForm`：`▸ 重构 Provider (正在修改 openai-compat.ts)`
- 导出 `hasPendingTodos()` 判断函数
- **全部完成时自动隐藏面板**（不再占悬浮层）

### 2.6 App.tsx

渲染条件从 `todos.length > 0` 改为 `hasPendingTodos(todos)`。

---

## 三、效果

### CLI 任务面板（有进行中的任务时显示）

```
📋 任务计划 (1/3 完成)
  ✓ 1. 读取配置文件
  ▸ 2. 重构 Provider (正在修改 openai-compat.ts)
  ○ 3. 写单元测试
```

### 全部完成时

面板自动消失，任务信息保留在历史消息中（tool_done 输出）：

```
Task plan updated: 3/3 completed. All tasks done — please verify the results.
✓ 读取配置文件
✓ 重构 Provider
✓ 写单元测试
```

---

## 四、测试

`tests/unit/tool-todo-write.test.ts` — 6 个测试全通过。

# AskUserQuestion 多步表单工具 — 实现总结

## 一、功能概述

新增 `ask_user_question` 工具，让 LLM 在 Agent Loop 执行过程中暂停并向用户提出结构化问题（单选/多选/文本），以多步表单形式收集用户回答后继续执行。

**核心场景**：需求澄清、方案选择、偏好收集等 human-in-the-loop 交互。

---

## 二、架构设计

### 2.1 技术选型：StreamableTool + 事件暂停

采用与 `dispatch_agent` 相同的 StreamableTool 模式：

```
LLM 调用 ask_user_question
  → stream() yield user_question_request 事件
  → AgentLoop yield* 透传到 UI
  → UI 渲染 UserQuestionForm 替换 InputBar
  → 用户填写/取消 → resolve Promise
  → stream() 拿到结果 → return ToolResult
  → AgentLoop 继续下一轮
```

选择 StreamableTool 而非普通 Tool 的原因：
- AsyncGenerator 天然支持 yield 暂停 + 等待外部输入
- 串行执行对用户问答合理（不应并行弹出多个表单）
- 与 dispatch_agent 的事件透传模式一致

### 2.2 新增事件类型

```typescript
// AgentEvent 新增
| { type: 'user_question_request'; questions: UserQuestion[]; resolve: (result: UserQuestionResult) => void }

// 问题定义
interface UserQuestion {
  key: string                    // 答案字段名
  title: string                  // 问题标题
  type: 'select' | 'multiselect' | 'text'
  options?: UserQuestionOption[] // select/multiselect 的选项
  placeholder?: string           // text 的占位提示
}

// 回答结果
interface UserQuestionResult {
  cancelled: boolean
  answers?: Record<string, string | string[]>
}
```

### 2.3 ToolResultMeta 扩展

```typescript
| { type: 'ask_user'; questionCount: number; answered: boolean; pairs?: Array<{ question: string; answer: string }> }
```

`pairs` 字段携带问答对，供 UI 层在历史消息中渲染可读摘要。

---

## 三、UI 交互

### 3.1 多步表单 — UserQuestionForm

| 元素 | 说明 |
|------|------|
| 顶部 Tab 指示器 | `← ◻ 产品领域  ◻ 关注维度  ✔ Submit →`，当前步骤反色高亮 |
| 问题区 | 根据 type 渲染：单选列表 / 多选复选框 / 文本输入框 |
| 特殊选项 | select 末尾追加 "Type something."；所有类型末尾追加 "Chat about this" |
| Submit 页 | 预览所有已填答案，两个选项：Submit answer / Cancel |
| 底部提示 | `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` |

### 3.2 键位映射

| 按键 | 行为 |
|------|------|
| `↑/↓` | 选项间移动光标 |
| `Enter` | select: 选中并前进；multiselect: 确认并前进；text: 提交并前进 |
| `Space` | multiselect: 切换勾选 |
| `Tab/→` | 进入下一步 |
| `Shift+Tab/←` | 回退上一步 |
| `Esc / Q` | 取消整个表单（兼容 IDE 终端 Esc 不可用的情况） |

### 3.3 视觉设计

- 当前步骤 Tab：`backgroundColor="cyan" color="black"` 反色高亮
- 光标所在选项：`backgroundColor="cyan" color="black"` 反色背景
- 已完成步骤：`✔` 标记
- Chat about this / Type something：灰色或反色

### 3.4 完成后摘要展示

工具完成后在消息历史中渲染问答摘要（对标 Claude Code）：

```
✓ AskUser(3 个问题)  3 个问题已回答  320ms
⎿  · 你想做哪个领域的产品？ → AI 驱动产品
   · 你的目标规模是怎样的？ → 个人 MVP 验证
```

问题灰色，答案 cyan 高亮。

---

## 四、多模式适配

| 模式 | 行为 |
|------|------|
| 交互模式（REPL） | 正常弹出表单，暂停等待用户回答 |
| 管道模式（pipe） | 直接返回 error `not_interactive`，LLM 自行决策 |
| 子 Agent（dispatch_agent） | 工具从子 Agent 工具集中排除，子 Agent 无法调用 |

### 实现方式

- **pipe 模式**：AgentConfig 新增 `nonInteractive` 字段 → ToolContext 透传 → 工具检测后直接 return error
- **子 Agent**：`dispatch_agent` 构建子 registry 时 `cloneWithout('dispatch_agent', 'ask_user_question')`

---

## 五、文件清单

| 类别 | 文件 | 变更 |
|------|------|------|
| 工具 | `src/tools/ask-user-question.ts` | **新增** StreamableTool 实现 |
| 类型 | `src/tools/types.ts` | ToolResultMeta 新增 ask_user，ToolContext 新增 nonInteractive |
| 事件 | `src/core/agent-loop.ts` | AgentEvent 新增 user_question_request，AgentConfig 新增 nonInteractive |
| 注册 | `src/core/bootstrap.ts` | 注册 AskUserQuestionTool |
| Pipe | `src/core/pipe-runner.ts` | 传递 nonInteractive: true |
| SubAgent | `src/tools/dispatch-agent.ts` | cloneWithout 排除 ask_user_question |
| UI 组件 | `src/ui/UserQuestionForm.tsx` | **新增** 多步表单组件 |
| UI Hook | `src/ui/useChat.ts` | pendingQuestion + resolveQuestion |
| UI 入口 | `src/ui/App.tsx` | 渲染 UserQuestionForm |
| UI 状态 | `src/ui/ToolStatusLine.tsx` | ask_user meta 展示 + 问答摘要渲染 |
| 测试 | `tests/unit/ask-user-question.test.ts` | **新增** 7 个用例 |

---

## 六、测试覆盖

| 测试文件 | 用例数 | 覆盖内容 |
|----------|--------|----------|
| `ask-user-question.test.ts` | 7 | 元信息、非交互拒绝、yield+resolve 流程、取消、空参数校验、execute fallback、meta 结构 |

全量：45 文件 / 348 通过 / 0 失败

---

## 七、设计决策记录

1. **StreamableTool vs 特殊机制**：选择 StreamableTool 而非在 AgentLoop 中硬编码，保持工具体系的统一性。
2. **nonInteractive 标志 vs 工具注册排除**：pipe 模式通过 ToolContext 标志让工具自行判断，而非从 registry 排除。这样 LLM 仍能看到工具定义，只是调用时返回错误，比直接隐藏工具更好（避免 prompt 差异导致行为不一致）。
3. **Q 键取消**：IDE 内嵌终端（如 IntelliJ IDEA）的 Esc 键可能被 IDE 拦截，Q 键作为备用取消方式。
4. **可读输出 vs JSON**：工具输出改为人类可读的 `question → answer` 格式而非 JSON，LLM 同样能解析，且在 pipe 模式的 --json 输出中也更友好。

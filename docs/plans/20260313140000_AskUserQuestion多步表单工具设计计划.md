# AskUserQuestion 工具实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AskUserQuestion 多步表单工具，让 LLM 在 agent loop 中暂停并向用户提出结构化问题（单选/多选/文本），获取答案后继续执行。

**Architecture:** AskUserQuestion 作为 StreamableTool 注册，yield `user_question_request` 事件暂停等待用户回答。UI 层接收事件后替换 InputBar 渲染多步表单（Tab 导航），用户提交/取消后 resolve Promise 唤醒 generator。pipe 模式下直接返回 error 拒绝调用。

**Tech Stack:** TypeScript, React/Ink, Vitest

---

## Chunk 1: 核心工具 + 事件类型 + 单元测试

### Task 1: 扩展类型定义

**Files:**
- Modify: `zCli/src/tools/types.ts` — 新增 ToolResultMeta 联合分支
- Modify: `zCli/src/core/agent-loop.ts` — 新增 AgentEvent 类型

- [ ] **Step 1: 在 ToolResultMeta 添加 ask_user 分支**

在 `src/tools/types.ts` 的 ToolResultMeta 联合类型末尾添加：

```typescript
| { type: 'ask_user'; questionCount: number; answered: boolean }
```

- [ ] **Step 2: 在 AgentEvent 添加 user_question_request 事件**

在 `src/core/agent-loop.ts` 的 AgentEvent 类型中，业务事件段落添加：

```typescript
| { type: 'user_question_request'; questions: UserQuestion[]; resolve: (result: UserQuestionResult) => void }
```

同时在文件顶部（AgentEvent 定义之前）导出接口：

```typescript
/** AskUserQuestion 工具 — 单个问题定义 */
export interface UserQuestion {
  /** 答案字段名，如 "domain", "focus" */
  key: string
  /** 问题标题 */
  title: string
  /** 问题类型 */
  type: 'select' | 'multiselect' | 'text'
  /** select/multiselect 时的选项列表 */
  options?: UserQuestionOption[]
  /** text 类型的输入提示 */
  placeholder?: string
}

export interface UserQuestionOption {
  label: string
  description?: string
}

/** AskUserQuestion 工具 — 用户回答结果 */
export interface UserQuestionResult {
  cancelled: boolean
  answers?: Record<string, string | string[]>
}
```

- [ ] **Step 3: 在 ToolContext 添加 nonInteractive 标志**

在 `src/tools/types.ts` 的 ToolContext 接口添加：

```typescript
/** 标记非交互模式（pipe），不可弹出用户交互 */
nonInteractive?: boolean
```

- [ ] **Step 4: 在 agent-loop.ts 的 buildToolContext 中传递 nonInteractive**

需要先在 AgentConfig 中添加 `nonInteractive` 字段，然后 buildToolContext 传递到 ToolContext。

AgentConfig 添加：
```typescript
/** 标记非交互模式，工具不可弹出用户界面 */
nonInteractive?: boolean | undefined
```

buildToolContext 函数补充：
```typescript
if (config.nonInteractive) { ctx.nonInteractive = config.nonInteractive }
```

- [ ] **Step 5: 确认类型检查通过**

Run: `cd zCli && npx tsc --noEmit 2>&1 | head -20`
Expected: 无新增错误

---

### Task 2: 实现 AskUserQuestionTool

**Files:**
- Create: `zCli/src/tools/ask-user-question.ts`
- Test: `zCli/tests/unit/ask-user-question.test.ts`

- [ ] **Step 1: 编写测试**

```typescript
// tests/unit/ask-user-question.test.ts
import { describe, it, expect } from 'vitest'
import { AskUserQuestionTool } from '@tools/ask-user-question.js'
import type { ToolContext } from '@tools/types.js'
import type { AgentEvent, UserQuestionResult } from '@core/agent-loop.js'

const baseCx: ToolContext = { cwd: '/tmp' }

describe('AskUserQuestionTool', () => {
  it('元信息正确', () => {
    const tool = new AskUserQuestionTool()
    expect(tool.name).toBe('ask_user_question')
    expect(tool.dangerous).toBe(false)
  })

  it('非交互模式直接返回 error', async () => {
    const tool = new AskUserQuestionTool()
    const ctx: ToolContext = { ...baseCx, nonInteractive: true }
    const args = { questions: [{ key: 'q1', title: 'test', type: 'text' }] }
    const gen = tool.stream(args, ctx)
    const result = await gen.next()
    // 非交互模式应直接 return（done=true），不 yield 任何事件
    expect(result.done).toBe(true)
    expect(result.value.success).toBe(false)
    expect(result.value.error).toBe('not_interactive')
  })

  it('交互模式 yield user_question_request 并等待 resolve', async () => {
    const tool = new AskUserQuestionTool()
    const questions = [
      { key: 'domain', title: '选择领域', type: 'select', options: [{ label: 'SaaS' }] },
    ]
    const gen = tool.stream({ questions }, baseCx)

    // 第一步应 yield user_question_request 事件
    const step1 = await gen.next()
    expect(step1.done).toBe(false)
    const event = step1.value as AgentEvent & { type: 'user_question_request' }
    expect(event.type).toBe('user_question_request')
    expect(event.questions).toEqual(questions)
    expect(typeof event.resolve).toBe('function')

    // 模拟用户提交答案
    event.resolve({ cancelled: false, answers: { domain: 'SaaS' } })
    const step2 = await gen.next()
    expect(step2.done).toBe(true)
    expect(step2.value.success).toBe(true)
    expect(step2.value.output).toContain('SaaS')
  })

  it('用户取消返回 cancelled error', async () => {
    const tool = new AskUserQuestionTool()
    const gen = tool.stream({ questions: [{ key: 'q', title: 'test', type: 'text' }] }, baseCx)
    const step1 = await gen.next()
    const event = step1.value as AgentEvent & { type: 'user_question_request' }

    event.resolve({ cancelled: true })
    const step2 = await gen.next()
    expect(step2.done).toBe(true)
    expect(step2.value.success).toBe(false)
    expect(step2.value.error).toBe('cancelled')
  })

  it('execute fallback 消费 stream', async () => {
    const tool = new AskUserQuestionTool()
    // 非交互模式下 execute 也应返回 error
    const ctx: ToolContext = { ...baseCx, nonInteractive: true }
    const result = await tool.execute({ questions: [] }, ctx)
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cd zCli && pnpm vitest run tests/unit/ask-user-question.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 AskUserQuestionTool**

创建 `src/tools/ask-user-question.ts`：

```typescript
// src/tools/ask-user-question.ts

/**
 * AskUserQuestionTool — 向用户提出多步结构化问题。
 *
 * StreamableTool 实现：
 * - stream(): yield user_question_request 暂停等待，return 用户答案
 * - execute(): fallback，消费 stream() 返回最终结果
 *
 * 非交互模式（pipe）下直接返回 error，不 yield 事件。
 */

import type { ToolContext, ToolResult, StreamableTool } from './types.js'
import type { AgentEvent, UserQuestion } from '@core/agent-loop.js'
import type { UserQuestionResult } from '@core/agent-loop.js'

export class AskUserQuestionTool implements StreamableTool {
  readonly name = 'ask_user_question'
  readonly description =
    'Ask the user a series of structured questions (single-select, multi-select, or free text) ' +
    'and collect their answers. Use this when you need to gather specific information from the user ' +
    'in a structured way, such as clarifying requirements, choosing between options, or collecting preferences.\n\n' +
    'The tool presents a multi-step form with Tab navigation between steps. ' +
    'Each step can be a single-select list, multi-select checkboxes, or free text input. ' +
    'The user can cancel at any step, in which case the tool returns an error with "cancelled".'
  readonly parameters = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'List of questions to ask the user, presented as a multi-step form',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Unique key for this answer (e.g., "domain", "focus")' },
            title: { type: 'string', description: 'The question text shown to the user' },
            type: { type: 'string', enum: ['select', 'multiselect', 'text'], description: 'Question type' },
            options: {
              type: 'array',
              description: 'Options for select/multiselect questions',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option text' },
                  description: { type: 'string', description: 'Optional description shown below the label' },
                },
                required: ['label'],
              },
            },
            placeholder: { type: 'string', description: 'Placeholder text for text input questions' },
          },
          required: ['key', 'title', 'type'],
        },
      },
    },
    required: ['questions'],
  }
  readonly dangerous = false

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gen = this.stream(args, ctx)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    return next.value
  }

  async *stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<AgentEvent, ToolResult> {
    // 非交互模式直接报错
    if (ctx.nonInteractive) {
      return {
        success: false,
        output: '非交互模式不支持 AskUserQuestion',
        error: 'not_interactive',
      }
    }

    // 解析 questions 参数
    const rawQuestions = args['questions']
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return {
        success: false,
        output: 'questions 参数不能为空',
        error: 'invalid_args',
      }
    }

    const questions = rawQuestions as UserQuestion[]

    // 构建 Promise，yield 事件暂停等待用户回答
    let resolveAnswer!: (result: UserQuestionResult) => void
    const promise = new Promise<UserQuestionResult>(r => { resolveAnswer = r })

    yield {
      type: 'user_question_request',
      questions,
      resolve: resolveAnswer,
    } satisfies AgentEvent

    const result = await promise

    if (result.cancelled) {
      return {
        success: false,
        output: '用户取消了问答',
        error: 'cancelled',
        meta: { type: 'ask_user', questionCount: questions.length, answered: false },
      }
    }

    return {
      success: true,
      output: JSON.stringify(result.answers ?? {}),
      meta: { type: 'ask_user', questionCount: questions.length, answered: true },
    }
  }
}
```

- [ ] **Step 4: 运行测试确认绿灯**

Run: `cd zCli && pnpm vitest run tests/unit/ask-user-question.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/ask-user-question.ts src/tools/types.ts src/core/agent-loop.ts tests/unit/ask-user-question.test.ts
git commit -m "feat(tool): AskUserQuestion 工具核心 — StreamableTool + 事件类型 + 单元测试"
```

---

### Task 3: 注册工具 + pipe 模式适配 + 子 Agent 排除

**Files:**
- Modify: `zCli/src/core/bootstrap.ts` — 注册 AskUserQuestionTool
- Modify: `zCli/src/tools/dispatch-agent.ts` — cloneWithout 排除
- Modify: `zCli/src/core/pipe-runner.ts` — 传递 nonInteractive

- [ ] **Step 1: 在 bootstrap.ts 注册工具**

在 import 段添加：
```typescript
import { AskUserQuestionTool } from '@tools/ask-user-question.js'
```

在 `buildRegistry()` 中 `reg.register(new SkillTool(skillStore))` 之前添加：
```typescript
reg.register(new AskUserQuestionTool())
```

- [ ] **Step 2: 在 dispatch-agent.ts 排除 ask_user_question**

修改子 Agent 构建受限工具集的行：
```typescript
// 原
const subRegistry = ctx.registry.cloneWithout('dispatch_agent')
// 新
const subRegistry = ctx.registry.cloneWithout('dispatch_agent', 'ask_user_question')
```

- [ ] **Step 3: 在 pipe-runner.ts 传递 nonInteractive**

在 `runPipe` 函数中创建 AgentLoop 时添加 `nonInteractive: true`：

```typescript
const loop = new AgentLoop(provider, options.noTools ? buildRegistry() : registry, {
  model: modelName,
  provider: providerName,
  signal: controller.signal,
  nonInteractive: true,  // ← 新增
  ...(sid ? { sessionId: sid } : {}),
})
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `cd zCli && npx tsc --noEmit && pnpm test`
Expected: 类型检查通过，全部测试通过

- [ ] **Step 5: 提交**

```bash
git add src/core/bootstrap.ts src/tools/dispatch-agent.ts src/core/pipe-runner.ts
git commit -m "feat(tool): 注册 AskUserQuestion + pipe 模式拒绝 + 子 Agent 排除"
```

---

## Chunk 2: UI 层 — 多步表单组件 + useChat 集成

### Task 4: UserQuestionForm 组件

**Files:**
- Create: `zCli/src/ui/UserQuestionForm.tsx`
- Test: `zCli/tests/unit/ui/user-question-form.test.ts`（可选，组件测试较重，优先手动验证）

- [ ] **Step 1: 创建 UserQuestionForm 组件**

```typescript
// src/ui/UserQuestionForm.tsx

/**
 * UserQuestionForm — AskUserQuestion 工具的多步表单 UI。
 *
 * 顶部 Tab 指示器显示所有步骤 + Submit 页。
 * 每一步根据问题类型渲染：select（单选列表）、multiselect（多选复选框）、text（文本输入）。
 * 每一步末尾追加 "Chat about this"（取消）选项。
 * select 类型额外追加 "Type something."（自定义输入）选项。
 *
 * 键位：
 *   ↑/↓     选项导航
 *   Enter   select: 选中并进入下一步；text: 提交输入并进入下一步
 *   Space   multiselect: 切换勾选
 *   Tab/→   下一步
 *   Shift+Tab/← 上一步
 *   Esc/Q   取消整个表单
 */

import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { UserQuestion, UserQuestionResult } from '@core/agent-loop.js'

interface UserQuestionFormProps {
  questions: UserQuestion[]
  onResolve: (result: UserQuestionResult) => void
}

/** 特殊选项标记 */
const CHAT_ABOUT_THIS = '__chat_about_this__'
const TYPE_SOMETHING = '__type_something__'

export function UserQuestionForm({ questions, onResolve }: UserQuestionFormProps) {
  // 总步骤 = questions.length + 1 (Submit 页)
  const totalSteps = questions.length + 1
  const [currentStep, setCurrentStep] = useState(0)
  const [cursor, setCursor] = useState(0)
  // 每个问题的已选答案
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  // multiselect 当前勾选集合（按 question key 索引）
  const [multiSelections, setMultiSelections] = useState<Record<string, Set<string>>>({})
  // select 类型自定义输入模式
  const [customInputMode, setCustomInputMode] = useState(false)
  const [customInputValue, setCustomInputValue] = useState('')
  // text 类型输入值
  const [textInputValue, setTextInputValue] = useState('')

  const isSubmitStep = currentStep >= questions.length

  // 当前问题
  const question = !isSubmitStep ? questions[currentStep] : null

  // 构建选项列表（含特殊选项）
  const getOptionLabels = useCallback((): string[] => {
    if (!question) return []
    const labels: string[] = []
    if (question.type === 'select' || question.type === 'multiselect') {
      for (const opt of question.options ?? []) {
        labels.push(opt.label)
      }
      if (question.type === 'select') {
        labels.push(TYPE_SOMETHING)
      }
    }
    labels.push(CHAT_ABOUT_THIS)
    return labels
  }, [question])

  const optionLabels = getOptionLabels()

  // 步骤切换时重置光标和输入
  const goToStep = useCallback((step: number) => {
    setCurrentStep(step)
    setCursor(0)
    setCustomInputMode(false)
    setCustomInputValue('')
    // text 类型恢复已有答案
    const q = step < questions.length ? questions[step] : null
    if (q?.type === 'text') {
      const existing = answers[q.key]
      setTextInputValue(typeof existing === 'string' ? existing : '')
    } else {
      setTextInputValue('')
    }
  }, [questions, answers])

  // 确认当前步骤并前进
  const confirmAndAdvance = useCallback(() => {
    if (!question) return
    const key = question.key

    if (question.type === 'select') {
      if (customInputMode) {
        if (customInputValue.trim()) {
          setAnswers(prev => ({ ...prev, [key]: customInputValue.trim() }))
          goToStep(currentStep + 1)
        }
        return
      }
      const label = optionLabels[cursor]
      if (label === CHAT_ABOUT_THIS) {
        onResolve({ cancelled: true })
        return
      }
      if (label === TYPE_SOMETHING) {
        setCustomInputMode(true)
        setCustomInputValue('')
        return
      }
      if (label) {
        setAnswers(prev => ({ ...prev, [key]: label }))
        goToStep(currentStep + 1)
      }
    } else if (question.type === 'multiselect') {
      const label = optionLabels[cursor]
      if (label === CHAT_ABOUT_THIS) {
        onResolve({ cancelled: true })
        return
      }
      // Enter on multiselect = 确认当前勾选并前进
      const selected = multiSelections[key] ?? new Set<string>()
      setAnswers(prev => ({ ...prev, [key]: [...selected] }))
      goToStep(currentStep + 1)
    } else if (question.type === 'text') {
      // 检查是否选中 Chat about this（text 末尾也有这个选项）
      if (cursor === 1) { // cursor 1 = Chat about this（text 模式只有输入框 + chat）
        onResolve({ cancelled: true })
        return
      }
      if (textInputValue.trim()) {
        setAnswers(prev => ({ ...prev, [key]: textInputValue.trim() }))
        goToStep(currentStep + 1)
      }
    }
  }, [question, cursor, optionLabels, customInputMode, customInputValue, textInputValue, multiSelections, currentStep, goToStep, onResolve])

  useInput((input, key) => {
    // Esc 或 Q 取消
    if (key.escape || input === 'q') {
      onResolve({ cancelled: true })
      return
    }

    // Submit 步骤
    if (isSubmitStep) {
      if (key.upArrow) setCursor(c => Math.max(0, c - 1))
      if (key.downArrow) setCursor(c => Math.min(1, c + 1))
      if (key.return) {
        if (cursor === 0) {
          // Submit answer
          onResolve({ cancelled: false, answers })
        } else {
          // Cancel
          onResolve({ cancelled: true })
        }
      }
      // ← 回退
      if (key.leftArrow || (key.tab && key.shift)) {
        goToStep(currentStep - 1)
      }
      return
    }

    // 自定义输入模式下只处理 Enter（提交）和 Esc（已处理）
    if (customInputMode) {
      if (key.return) confirmAndAdvance()
      return
    }

    // text 类型：Enter 提交
    if (question?.type === 'text') {
      if (key.return) confirmAndAdvance()
      if (key.downArrow) setCursor(c => Math.min(1, c + 1))
      if (key.upArrow) setCursor(c => Math.max(0, c - 1))
      return
    }

    // 方向键导航
    if (key.upArrow) setCursor(c => Math.max(0, c - 1))
    if (key.downArrow) setCursor(c => Math.min(optionLabels.length - 1, c + 1))

    // Space: multiselect 切换勾选
    if (input === ' ' && question?.type === 'multiselect') {
      const label = optionLabels[cursor]
      if (label && label !== CHAT_ABOUT_THIS) {
        setMultiSelections(prev => {
          const key = question.key
          const set = new Set(prev[key] ?? [])
          if (set.has(label)) set.delete(label)
          else set.add(label)
          return { ...prev, [key]: set }
        })
      }
    }

    // Enter: 确认
    if (key.return) confirmAndAdvance()

    // Tab/→: 下一步
    if ((key.tab && !key.shift) || key.rightArrow) {
      if (currentStep < totalSteps - 1) {
        // 保存当前步骤答案（如果有）
        if (question?.type === 'multiselect') {
          const selected = multiSelections[question.key] ?? new Set<string>()
          if (selected.size > 0) {
            setAnswers(prev => ({ ...prev, [question.key]: [...selected] }))
          }
        }
        goToStep(currentStep + 1)
      }
    }

    // Shift+Tab/←: 上一步
    if ((key.tab && key.shift) || key.leftArrow) {
      if (currentStep > 0) {
        goToStep(currentStep - 1)
      }
    }
  })

  return (
    <Box flexDirection="column">
      {/* Tab 指示器 */}
      <Box>
        {questions.map((q, i) => (
          <Box key={q.key} marginRight={1}>
            {i === currentStep
              ? <Text color="cyan" bold>{'← '}{i < currentStep ? '✓' : '□'} {q.key}</Text>
              : <Text dimColor>{i < currentStep ? '✓' : '□'} {q.key}</Text>
            }
          </Box>
        ))}
        <Box marginRight={1}>
          {isSubmitStep
            ? <Text color="green" bold>{'✔ Submit →'}</Text>
            : <Text dimColor>{'✔ Submit'}</Text>
          }
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {isSubmitStep ? (
          /* Submit 页 */
          <>
            <Text bold>确认提交？</Text>
            <Box marginTop={1} flexDirection="column">
              {/* 已填答案预览 */}
              {Object.entries(answers).map(([k, v]) => (
                <Text key={k} dimColor>  {k}: {Array.isArray(v) ? v.join(', ') : v}</Text>
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Box paddingLeft={1}>
                {cursor === 0
                  ? <Text color="cyan">{'❯ '}1. Submit answer</Text>
                  : <Text>{'  '}1. Submit answer</Text>
                }
              </Box>
              <Box paddingLeft={1}>
                {cursor === 1
                  ? <Text color="cyan">{'❯ '}2. Cancel</Text>
                  : <Text>{'  '}2. Cancel</Text>
                }
              </Box>
            </Box>
          </>
        ) : question?.type === 'text' ? (
          /* Text 输入 */
          <>
            <Text bold>{question.title}</Text>
            <Box marginTop={1} flexDirection="column">
              <Box paddingLeft={1}>
                {cursor === 0
                  ? <Text color="cyan">{'❯ '}<TextInput value={textInputValue} onChange={setTextInputValue} placeholder={question.placeholder ?? 'Type your answer...'} /></Text>
                  : <Text>{'  '}<TextInput value={textInputValue} onChange={setTextInputValue} placeholder={question.placeholder ?? 'Type your answer...'} /></Text>
                }
              </Box>
              <Box paddingLeft={1}>
                {cursor === 1
                  ? <Text color="cyan">{'❯ '}Chat about this</Text>
                  : <Text dimColor>{'  '}Chat about this</Text>
                }
              </Box>
            </Box>
          </>
        ) : customInputMode ? (
          /* 自定义输入 */
          <>
            <Text bold>{question?.title}</Text>
            <Box marginTop={1} paddingLeft={1}>
              <Text color="cyan">{'❯ '}</Text>
              <TextInput value={customInputValue} onChange={setCustomInputValue} placeholder="Type something..." />
            </Box>
          </>
        ) : (
          /* Select / Multiselect */
          <>
            <Text bold>{question?.title}</Text>
            <Box marginTop={1} flexDirection="column">
              {optionLabels.map((label, i) => {
                const isChat = label === CHAT_ABOUT_THIS
                const isType = label === TYPE_SOMETHING
                const isCurrent = i === cursor

                // multiselect 勾选标记
                let prefix = '  '
                if (isCurrent) prefix = '❯ '

                let checkbox = ''
                if (question?.type === 'multiselect' && !isChat) {
                  const selected = multiSelections[question.key] ?? new Set()
                  checkbox = selected.has(label) ? '◉ ' : '○ '
                }

                // 选项描述
                const opt = question?.options?.[i]
                const desc = opt?.description

                if (isChat) {
                  return (
                    <Box key="chat" paddingLeft={1} marginTop={1}>
                      {isCurrent
                        ? <Text color="cyan">{prefix}Chat about this</Text>
                        : <Text dimColor>{prefix}Chat about this</Text>
                      }
                    </Box>
                  )
                }
                if (isType) {
                  return (
                    <Box key="type" paddingLeft={1}>
                      {isCurrent
                        ? <Text color="cyan">{prefix}Type something.</Text>
                        : <Text>{prefix}Type something.</Text>
                      }
                    </Box>
                  )
                }

                return (
                  <Box key={label} paddingLeft={1} flexDirection="column">
                    <Box>
                      {isCurrent
                        ? <Text color="cyan">{prefix}{checkbox}{i + 1}. {label}</Text>
                        : <Text>{prefix}{checkbox}{i + 1}. {label}</Text>
                      }
                    </Box>
                    {desc && (
                      <Box paddingLeft={4}>
                        <Text dimColor>{desc}</Text>
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          </>
        )}
      </Box>

      {/* 底部导航提示 */}
      <Box marginTop={1}>
        <Text dimColor>Enter to select · Tab/Arrow keys to navigate · Esc to cancel</Text>
      </Box>
    </Box>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd zCli && npx tsc --noEmit 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add src/ui/UserQuestionForm.tsx
git commit -m "feat(ui): UserQuestionForm 多步表单组件 — 单选/多选/文本 + Tab 导航"
```

---

### Task 5: useChat 集成 + App 渲染

**Files:**
- Modify: `zCli/src/ui/useChat.ts` — 处理 user_question_request 事件
- Modify: `zCli/src/ui/App.tsx` — 渲染 UserQuestionForm

- [ ] **Step 1: 在 useChat 中添加 pendingQuestion 状态**

1. 在文件顶部导入：
```typescript
import type { UserQuestion, UserQuestionResult } from '@core/agent-loop.js'
```

2. 在 PendingPermission 接口下方添加：
```typescript
/** 待用户回答的问题表单，暂停 AgentLoop 直到 resolve 被调用 */
interface PendingQuestion {
  questions: UserQuestion[]
  resolve: (result: UserQuestionResult) => void
}
```

3. 在 UseChatReturn 接口添加：
```typescript
pendingQuestion: PendingQuestion | null
resolveQuestion: (result: UserQuestionResult) => void
```

4. 在 useChat 函数内添加 state：
```typescript
const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
```

5. 添加 resolveQuestion 回调：
```typescript
const resolveQuestion = useCallback((result: UserQuestionResult) => {
  setPendingQuestion(prev => {
    if (!prev) return null
    prev.resolve(result)
    return null
  })
}, [])
```

6. 在事件循环中添加 user_question_request 处理（在 permission_request 之后）：
```typescript
} else if (event.type === 'user_question_request') {
  setPendingQuestion({ questions: event.questions, resolve: event.resolve })
}
```

7. 在 return 对象中添加：
```typescript
pendingQuestion,
resolveQuestion,
```

- [ ] **Step 2: 在 App.tsx 中渲染 UserQuestionForm**

1. 导入组件：
```typescript
import { UserQuestionForm } from './UserQuestionForm.js'
```

2. 从 useChat 解构新字段：
```typescript
const { ..., pendingQuestion, resolveQuestion } = useChat()
```

3. 在 JSX 的条件渲染链中，在 `pendingPermission` 判断之后添加 `pendingQuestion` 分支：

```tsx
{pendingPermission != null ? (
  <PermissionDialog ... />
) : pendingQuestion != null ? (
  <UserQuestionForm
    questions={pendingQuestion.questions}
    onResolve={resolveQuestion}
  />
) : showModelPicker ? (
  ...原有逻辑
)}
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `cd zCli && npx tsc --noEmit && pnpm test`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/ui/useChat.ts src/ui/App.tsx
git commit -m "feat(ui): useChat + App 集成 AskUserQuestion 表单渲染"
```

---

### Task 6: ToolStatusLine 展示 ask_user meta

**Files:**
- Modify: `zCli/src/ui/ToolStatusLine.tsx` — 处理 ask_user meta 类型

- [ ] **Step 1: 在 ToolStatusLine 的 meta 展示逻辑中添加 ask_user**

找到 meta 渲染逻辑（formatMetaSummary 或类似函数），添加：

```typescript
case 'ask_user':
  return meta.answered
    ? `${meta.questionCount} 个问题已回答`
    : `${meta.questionCount} 个问题（已取消）`
```

在 Running 状态的展示中，为 `ask_user_question` 工具添加自定义动作描述：
```typescript
if (toolName === 'ask_user_question') return '等待用户回答...'
```

- [ ] **Step 2: 全量测试**

Run: `cd zCli && pnpm test`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/ui/ToolStatusLine.tsx
git commit -m "feat(ui): ToolStatusLine 支持 ask_user meta 展示"
```

---

## Chunk 3: 收尾 — 全量验证 + 文档

### Task 7: 全量验证

- [ ] **Step 1: 类型检查**

Run: `cd zCli && npx tsc --noEmit`
Expected: 无错误（已知 CommandSuggestion.tsx 除外）

- [ ] **Step 2: 全量测试**

Run: `cd zCli && pnpm test`
Expected: 全部通过

- [ ] **Step 3: 手动集成验证**

Run: `cd zCli && pnpm dev`

测试场景：
1. 在对话中让 LLM 使用 ask_user_question 工具（如发送"帮我做一个产品需求分析"）
2. 验证多步表单显示正常
3. 验证 Tab/方向键导航
4. 验证 Esc/Q 取消
5. 验证 Submit 提交后 LLM 收到答案

- [ ] **Step 4: 最终提交**

如有修复，统一提交：
```bash
git add -A
git commit -m "fix: AskUserQuestion 集成修复"
```

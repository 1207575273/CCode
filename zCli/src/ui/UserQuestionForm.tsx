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
 *   ↑/↓         选项导航
 *   Enter       select: 选中并前进；multiselect: 确认勾选并前进；text: 提交输入并前进
 *   Space       multiselect: 切换勾选
 *   Tab/→       下一步
 *   Shift+Tab/← 上一步
 *   Esc/Q       取消整个表单
 */

import React, { useState, useCallback, useMemo } from 'react'
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
  const totalSteps = questions.length + 1 // +1 为 Submit 页
  const [currentStep, setCurrentStep] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  // multiselect 勾选状态
  const [multiSelections, setMultiSelections] = useState<Record<string, Set<string>>>({})
  // select 自定义输入模式
  const [customInputMode, setCustomInputMode] = useState(false)
  const [customInputValue, setCustomInputValue] = useState('')
  // text 类型输入值
  const [textInputValue, setTextInputValue] = useState('')

  const isSubmitStep = currentStep >= questions.length
  const question = !isSubmitStep ? questions[currentStep] : null

  // 构建当前步骤的选项列表（含特殊选项）
  const optionLabels = useMemo((): string[] => {
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

  // 切换步骤
  const goToStep = useCallback((step: number) => {
    setCurrentStep(step)
    setCursor(0)
    setCustomInputMode(false)
    setCustomInputValue('')
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
      const selected = multiSelections[key] ?? new Set<string>()
      setAnswers(prev => ({ ...prev, [key]: [...selected] }))
      goToStep(currentStep + 1)
    } else if (question.type === 'text') {
      // cursor 0 = 输入框, cursor 1 = Chat about this
      if (cursor === 1) {
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
    // Esc 或 Q 取消整个表单
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
          onResolve({ cancelled: false, answers })
        } else {
          onResolve({ cancelled: true })
        }
      }
      if (key.leftArrow || (key.tab && key.shift)) {
        goToStep(currentStep - 1)
      }
      return
    }

    // 自定义输入模式：只处理 Enter 提交
    if (customInputMode) {
      if (key.return) confirmAndAdvance()
      return
    }

    // text 类型
    if (question?.type === 'text') {
      if (key.return) confirmAndAdvance()
      if (key.downArrow) setCursor(c => Math.min(1, c + 1))
      if (key.upArrow) setCursor(c => Math.max(0, c - 1))
      // Tab/→ 导航到下一步
      if ((key.tab && !key.shift) || key.rightArrow) {
        if (currentStep < totalSteps - 1) {
          if (textInputValue.trim()) {
            setAnswers(prev => ({ ...prev, [question.key]: textInputValue.trim() }))
          }
          goToStep(currentStep + 1)
        }
      }
      if ((key.tab && key.shift) || key.leftArrow) {
        if (currentStep > 0) goToStep(currentStep - 1)
      }
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
          const qKey = question.key
          const set = new Set(prev[qKey] ?? [])
          if (set.has(label)) set.delete(label)
          else set.add(label)
          return { ...prev, [qKey]: set }
        })
      }
    }

    // Enter: 确认
    if (key.return) confirmAndAdvance()

    // Tab/→: 下一步
    if ((key.tab && !key.shift) || key.rightArrow) {
      if (currentStep < totalSteps - 1) {
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
      if (currentStep > 0) goToStep(currentStep - 1)
    }
  })

  return (
    <Box flexDirection="column">
      {/* Tab 指示器 */}
      <StepTabs questions={questions} currentStep={currentStep} />

      <Box marginTop={1} flexDirection="column">
        {isSubmitStep ? (
          <SubmitStep answers={answers} cursor={cursor} />
        ) : question?.type === 'text' ? (
          <TextStep
            question={question}
            cursor={cursor}
            textValue={textInputValue}
            onTextChange={setTextInputValue}
          />
        ) : customInputMode ? (
          <CustomInputStep
            title={question?.title ?? ''}
            value={customInputValue}
            onChange={setCustomInputValue}
          />
        ) : (
          <SelectStep
            question={question!}
            optionLabels={optionLabels}
            cursor={cursor}
            multiSelections={multiSelections}
          />
        )}
      </Box>

      {/* 底部导航提示 */}
      <Box marginTop={1}>
        <Text dimColor>Enter to select · Tab/Arrow keys to navigate · Esc to cancel</Text>
      </Box>
    </Box>
  )
}

// ═══════════════════════════════════════════════
// 子组件
// ═══════════════════════════════════════════════

function StepTabs({ questions, currentStep }: { questions: UserQuestion[]; currentStep: number }) {
  const isSubmit = currentStep >= questions.length
  return (
    <Box>
      <Text dimColor>{'← '}</Text>
      {questions.map((q, i) => {
        const done = i < currentStep
        const active = i === currentStep
        const icon = done ? ' ✔ ' : ' ◻ '
        const label = `${icon}${q.key} `
        return (
          <Box key={q.key} marginRight={1}>
            {active
              ? <Text backgroundColor="cyan" color="black" bold>{label}</Text>
              : <Text dimColor>{label}</Text>
            }
          </Box>
        )
      })}
      <Box marginLeft={1}>
        {isSubmit
          ? <Text backgroundColor="green" color="black" bold>{' ✔ Submit '}</Text>
          : <Text dimColor>{' ✔ Submit'}</Text>
        }
      </Box>
      <Text dimColor>{' →'}</Text>
    </Box>
  )
}

function SubmitStep({ answers, cursor }: { answers: Record<string, string | string[]>; cursor: number }) {
  return (
    <>
      <Text bold>确认提交？</Text>
      <Box marginTop={1} flexDirection="column">
        {Object.entries(answers).map(([k, v]) => (
          <Text key={k} dimColor>  {k}: {Array.isArray(v) ? v.join(', ') : v}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box paddingLeft={1}>
          {cursor === 0
            ? <Text backgroundColor="cyan" color="black">{' ❯ 1. Submit answer '}</Text>
            : <Text>{'  '}1. Submit answer</Text>
          }
        </Box>
        <Box paddingLeft={1}>
          {cursor === 1
            ? <Text backgroundColor="cyan" color="black">{' ❯ 2. Cancel '}</Text>
            : <Text>{'  '}2. Cancel</Text>
          }
        </Box>
      </Box>
    </>
  )
}

function TextStep({
  question, cursor, textValue, onTextChange,
}: {
  question: UserQuestion; cursor: number; textValue: string; onTextChange: (v: string) => void
}) {
  return (
    <>
      <Text bold>{question.title}</Text>
      <Box marginTop={1} flexDirection="column">
        <Box paddingLeft={1}>
          {cursor === 0
            ? <><Text backgroundColor="cyan" color="black">{' ❯ '}</Text><Text> </Text><TextInput value={textValue} onChange={onTextChange} placeholder={question.placeholder ?? 'Type your answer...'} /></>
            : <><Text>{'   '}</Text><TextInput value={textValue} onChange={onTextChange} placeholder={question.placeholder ?? 'Type your answer...'} /></>
          }
        </Box>
        <Box paddingLeft={1} marginTop={1}>
          {cursor === 1
            ? <Text backgroundColor="cyan" color="black">{' ❯ Chat about this '}</Text>
            : <Text dimColor>{'   '}Chat about this</Text>
          }
        </Box>
      </Box>
    </>
  )
}

function CustomInputStep({
  title, value, onChange,
}: {
  title: string; value: string; onChange: (v: string) => void
}) {
  return (
    <>
      <Text bold>{title}</Text>
      <Box marginTop={1} paddingLeft={1}>
        <Text backgroundColor="cyan" color="black">{' ❯ '}</Text>
        <Text> </Text>
        <TextInput value={value} onChange={onChange} placeholder="Type something..." />
      </Box>
    </>
  )
}

function SelectStep({
  question, optionLabels, cursor, multiSelections,
}: {
  question: UserQuestion
  optionLabels: string[]
  cursor: number
  multiSelections: Record<string, Set<string>>
}) {
  const isMulti = question.type === 'multiselect'
  const selected = isMulti ? (multiSelections[question.key] ?? new Set<string>()) : new Set<string>()

  return (
    <>
      <Text bold>{question.title}</Text>
      <Box marginTop={1} flexDirection="column">
        {optionLabels.map((label, i) => {
          const isChat = label === CHAT_ABOUT_THIS
          const isType = label === TYPE_SOMETHING
          const isCurrent = i === cursor
          const prefix = isCurrent ? '❯ ' : '  '

          // multiselect 勾选标记
          let checkbox = ''
          if (isMulti && !isChat) {
            checkbox = selected.has(label) ? '◉ ' : '○ '
          }

          // 原始选项的描述（特殊选项无描述）
          const optIndex = i
          const desc = (!isChat && !isType) ? question.options?.[optIndex]?.description : undefined

          if (isChat) {
            return (
              <Box key="__chat__" paddingLeft={1} marginTop={1}>
                {isCurrent
                  ? <Text backgroundColor="cyan" color="black">{' ❯ Chat about this '}</Text>
                  : <Text dimColor>{'   '}Chat about this</Text>
                }
              </Box>
            )
          }
          if (isType) {
            return (
              <Box key="__type__" paddingLeft={1}>
                {isCurrent
                  ? <Text backgroundColor="cyan" color="black">{` ❯ Type something. `}</Text>
                  : <Text>{'   '}Type something.</Text>
                }
              </Box>
            )
          }

          return (
            <Box key={`opt-${i}`} paddingLeft={1} flexDirection="column">
              <Box>
                {isCurrent
                  ? <Text backgroundColor="cyan" color="black">{` ❯ ${checkbox}${i + 1}. ${label} `}</Text>
                  : <Text>{`   ${checkbox}${i + 1}. ${label}`}</Text>
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
  )
}

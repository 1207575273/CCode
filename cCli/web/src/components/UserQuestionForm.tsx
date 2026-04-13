// src/components/UserQuestionForm.tsx

/**
 * 用户问卷表单 — Tab 切换模式（与 CLI 端一致）。
 * 每个问题一个 Tab 页，而不是上下平铺。
 */

import { useState, useCallback } from 'react'
import type { UserQuestion } from '../types'

interface Props {
  questions: UserQuestion[]
  onSubmit: (answers: Record<string, string | string[]>) => void
  onCancel: () => void
}

export function UserQuestionForm({ questions, onSubmit, onCancel }: Props) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => {
    const init: Record<string, string | string[]> = {}
    for (const q of questions) {
      init[q.key] = q.type === 'multiselect' ? [] : ''
    }
    return init
  })
  const [activeIdx, setActiveIdx] = useState(0)

  const handleChange = useCallback((key: string, value: string | string[]) => {
    setAnswers(prev => ({ ...prev, [key]: value }))
  }, [])

  const handleSubmit = useCallback(() => {
    onSubmit(answers)
  }, [answers, onSubmit])

  const activeQ = questions[activeIdx]
  if (!activeQ) return null

  const isLast = activeIdx === questions.length - 1
  const isFirst = activeIdx === 0
  // 当前问题是否已回答
  const hasAnswer = activeQ.type === 'multiselect'
    ? (answers[activeQ.key] as string[]).length > 0
    : Boolean(answers[activeQ.key])

  return (
    <div className="mx-4 my-2 p-4 bg-blue-900/30 border border-blue-600/50 rounded-lg">
      {/* 标题 + 进度 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-accent text-lg">?</span>
          <span className="font-medium text-blue-200">需要你的输入</span>
        </div>
        {questions.length > 1 && (
          <span className="text-xs text-txt-secondary">{activeIdx + 1} / {questions.length}</span>
        )}
      </div>

      {/* Tab 标签（多个问题时显示） */}
      {questions.length > 1 && (
        <div className="flex gap-1 mb-3 border-b border-border">
          {questions.map((q, i) => {
            const answered = q.type === 'multiselect'
              ? (answers[q.key] as string[]).length > 0
              : Boolean(answers[q.key])
            return (
              <button key={q.key} onClick={() => setActiveIdx(i)}
                className={`px-3 py-1.5 text-xs border-b-2 -mb-[1px] transition-colors ${
                  i === activeIdx
                    ? 'border-blue-500 text-accent'
                    : answered
                      ? 'border-green-500/50 text-success/70'
                      : 'border-transparent text-txt-secondary hover:text-txt-primary'
                }`}>
                {answered && i !== activeIdx ? '✓ ' : ''}{q.title.length > 15 ? q.title.slice(0, 12) + '...' : q.title}
              </button>
            )
          })}
        </div>
      )}

      {/* 当前问题内容 */}
      <div className="min-h-[120px]">
        <label className="block text-sm font-medium text-txt-primary mb-2">{activeQ.title}</label>

        {activeQ.type === 'text' && (
          <textarea
            value={answers[activeQ.key] as string}
            onChange={e => handleChange(activeQ.key, e.target.value)}
            placeholder={activeQ.placeholder}
            rows={3}
            className="w-full bg-elevated text-txt-primary rounded px-3 py-2 text-sm outline-none focus:border-accent focus:outline-none placeholder-txt-muted resize-none"
          />
        )}

        {activeQ.type === 'select' && activeQ.options && (
          <div className="space-y-1 max-h-[240px] overflow-y-auto">
            {activeQ.options.map(opt => (
              <label key={opt.label}
                className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  answers[activeQ.key] === opt.label
                    ? 'bg-blue-800/50 border border-blue-500'
                    : 'hover:bg-elevated border border-transparent'
                }`}>
                <input type="radio" name={activeQ.key}
                  checked={answers[activeQ.key] === opt.label}
                  onChange={() => handleChange(activeQ.key, opt.label)}
                  className="mt-0.5" />
                <div>
                  <div className="text-sm text-txt-primary">{opt.label}</div>
                  {opt.description && <div className="text-xs text-txt-secondary mt-0.5">{opt.description}</div>}
                </div>
              </label>
            ))}
          </div>
        )}

        {activeQ.type === 'multiselect' && activeQ.options && (
          <div className="space-y-1 max-h-[240px] overflow-y-auto">
            {activeQ.options.map(opt => {
              const selected = (answers[activeQ.key] as string[]).includes(opt.label)
              return (
                <label key={opt.label}
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                    selected
                      ? 'bg-blue-800/50 border border-blue-500'
                      : 'hover:bg-elevated border border-transparent'
                  }`}>
                  <input type="checkbox" checked={selected}
                    onChange={() => {
                      const current = answers[activeQ.key] as string[]
                      handleChange(activeQ.key, selected ? current.filter(v => v !== opt.label) : [...current, opt.label])
                    }}
                    className="mt-0.5" />
                  <div>
                    <div className="text-sm text-txt-primary">{opt.label}</div>
                    {opt.description && <div className="text-xs text-txt-secondary mt-0.5">{opt.description}</div>}
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* 底部按钮 */}
      <div className="flex items-center justify-between mt-4">
        <div className="flex gap-2">
          {!isFirst && (
            <button onClick={() => setActiveIdx(activeIdx - 1)}
              className="px-3 py-1.5 bg-elevated text-txt-primary rounded hover:bg-elevated text-sm">
              上一题
            </button>
          )}
          {!isLast && (
            <button onClick={() => setActiveIdx(activeIdx + 1)}
              disabled={!hasAnswer}
              className="px-3 py-1.5 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm">
              下一题
            </button>
          )}
          {isLast && (
            <button onClick={handleSubmit}
              className="px-4 py-1.5 bg-success text-white rounded hover:bg-success text-sm">
              提交
            </button>
          )}
        </div>
        <button onClick={onCancel} className="px-3 py-1.5 bg-elevated text-txt-primary rounded hover:bg-elevated text-sm">
          取消
        </button>
      </div>
    </div>
  )
}

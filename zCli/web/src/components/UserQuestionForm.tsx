// src/components/UserQuestionForm.tsx

import { useState, useCallback } from 'react'
import type { UserQuestion } from '../types.js'

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

  const handleChange = useCallback((key: string, value: string | string[]) => {
    setAnswers(prev => ({ ...prev, [key]: value }))
  }, [])

  const handleSubmit = useCallback(() => {
    onSubmit(answers)
  }, [answers, onSubmit])

  return (
    <div className="mx-4 my-2 p-4 bg-blue-900/30 border border-blue-600/50 rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-blue-400 text-lg">?</span>
        <span className="font-medium text-blue-200">需要你的输入</span>
      </div>

      <div className="space-y-4">
        {questions.map(q => (
          <div key={q.key}>
            <label className="block text-sm font-medium text-gray-300 mb-1">{q.title}</label>

            {q.type === 'text' && (
              <input
                type="text"
                value={answers[q.key] as string}
                onChange={e => handleChange(q.key, e.target.value)}
                placeholder={q.placeholder}
                className="w-full bg-gray-800 text-gray-100 rounded px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
              />
            )}

            {q.type === 'select' && q.options && (
              <div className="space-y-1">
                {q.options.map(opt => (
                  <label
                    key={opt.label}
                    className={`flex items-start gap-2 p-2 rounded cursor-pointer transition-colors ${
                      answers[q.key] === opt.label ? 'bg-blue-800/50 border border-blue-500' : 'hover:bg-gray-800 border border-transparent'
                    }`}
                  >
                    <input
                      type="radio"
                      name={q.key}
                      checked={answers[q.key] === opt.label}
                      onChange={() => handleChange(q.key, opt.label)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm text-gray-200">{opt.label}</div>
                      {opt.description && <div className="text-xs text-gray-400">{opt.description}</div>}
                    </div>
                  </label>
                ))}
              </div>
            )}

            {q.type === 'multiselect' && q.options && (
              <div className="space-y-1">
                {q.options.map(opt => {
                  const selected = (answers[q.key] as string[]).includes(opt.label)
                  return (
                    <label
                      key={opt.label}
                      className={`flex items-start gap-2 p-2 rounded cursor-pointer transition-colors ${
                        selected ? 'bg-blue-800/50 border border-blue-500' : 'hover:bg-gray-800 border border-transparent'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          const current = answers[q.key] as string[]
                          handleChange(
                            q.key,
                            selected ? current.filter(v => v !== opt.label) : [...current, opt.label],
                          )
                        }}
                        className="mt-1"
                      />
                      <div>
                        <div className="text-sm text-gray-200">{opt.label}</div>
                        {opt.description && <div className="text-xs text-gray-400">{opt.description}</div>}
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-4">
        <button onClick={handleSubmit} className="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm">
          提交
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 bg-gray-700 text-gray-300 rounded hover:bg-gray-600 text-sm">
          取消
        </button>
      </div>
    </div>
  )
}

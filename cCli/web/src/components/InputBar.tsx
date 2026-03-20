// src/components/InputBar.tsx
import { useState, useCallback } from 'react'
import type { KeyboardEvent } from 'react'

interface Props {
  onSubmit: (text: string) => void
  disabled?: boolean
}

export function InputBar({ onSubmit, disabled }: Props) {
  const [text, setText] = useState('')

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    setText('')
  }, [text, disabled, onSubmit])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  return (
    <div className="flex gap-2 p-4 border-t border-gray-700">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
        disabled={disabled}
        className="flex-1 bg-gray-800 text-gray-100 rounded-lg px-4 py-3 resize-none outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500 disabled:opacity-50"
        rows={2}
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !text.trim()}
        className="self-end px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors"
      >
        发送
      </button>
    </div>
  )
}

// src/components/InputBar.tsx
import { useState, useCallback } from 'react'
import type { KeyboardEvent, ClipboardEvent } from 'react'
import { compressImage } from '../utils/image-compress'

interface Attachment {
  id: string
  url: string
}

interface Props {
  onSubmit: (text: string, imageIds?: string[]) => void
  disabled?: boolean
}

export function InputBar({ onSubmit, disabled }: Props) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || disabled) return
    const imageIds = attachments.length > 0 ? attachments.map(a => a.id) : undefined
    onSubmit(trimmed, imageIds)
    setText('')
    setAttachments([])
  }, [text, disabled, onSubmit, attachments])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  /** 拦截粘贴事件，识别图片并压缩上传 */
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const imageItem = items.find(item => item.type.startsWith('image/'))
    if (!imageItem) return // 非图片粘贴，走默认行为

    e.preventDefault()
    const blob = imageItem.getAsFile()
    if (!blob) return

    setUploading(true)
    try {
      const compressed = await compressImage(blob)
      const formData = new FormData()
      formData.append('file', compressed, 'screenshot.jpg')
      const resp = await fetch('/api/images/upload', { method: 'POST', body: formData })
      const data = (await resp.json()) as { id: string; url: string }
      setAttachments(prev => [...prev, data])
    } catch (err) {
      console.error('图片上传失败:', err)
    }
    setUploading(false)
  }, [])

  /** 移除指定附件 */
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  return (
    <div>
      <div className="flex gap-2 p-4 border-t border-gray-700">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          // TODO: 图片粘贴暂时屏蔽，待多模态模型调度策略设计完成后开启
          // onPaste={handlePaste}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={disabled}
          className="flex-1 bg-gray-800 text-gray-100 rounded-lg px-4 py-3 resize-none outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500 disabled:opacity-50"
          rows={2}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          className="self-end px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors"
        >
          发送
        </button>
      </div>

      {/* 附件条：有附件或正在上传时显示 */}
      {(attachments.length > 0 || uploading) && (
        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">📎 {attachments.length} 张附件</span>
          {attachments.map(att => (
            <div key={att.id} className="relative group">
              <img
                src={att.url}
                alt="附件"
                className="w-16 h-16 object-cover rounded border border-gray-600"
              />
              <button
                onClick={() => removeAttachment(att.id)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-600 text-white text-[10px] rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ))}
          {uploading && <span className="text-xs text-gray-500">上传中...</span>}
        </div>
      )}
    </div>
  )
}

// src/components/MessageBubble.tsx

import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { ToolHistoryBlock } from './ToolHistoryBlock.js'
import type { ChatMessage } from '../types.js'

interface Props {
  message: ChatMessage
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const sourceTag = message.source === 'web' ? ' (web)' : message.source === 'cli' ? ' (cli)' : ''

  // system 消息：如果有 toolEvents，渲染结构化工具历史块
  if (isSystem && message.toolEvents && message.toolEvents.length > 0) {
    return (
      <div className="mb-3 px-2">
        <ToolHistoryBlock events={message.toolEvents} />
      </div>
    )
  }

  // system 消息：纯文本（错误、状态通知等）
  if (isSystem) {
    return (
      <div className="mb-3 px-2">
        <span className="text-xs text-gray-500">{message.content}</span>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[80%] rounded-lg px-4 py-3 ${
        isUser ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-100'
      }`}>
        {sourceTag && (
          <span className="text-xs opacity-50 mb-1 block">{sourceTag}</span>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

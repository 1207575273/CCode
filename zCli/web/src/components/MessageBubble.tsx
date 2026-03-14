// src/components/MessageBubble.tsx
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../types.js'

interface Props {
  message: ChatMessage
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const sourceTag = message.source === 'web' ? ' (web)' : message.source === 'cli' ? ' (cli)' : ''

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

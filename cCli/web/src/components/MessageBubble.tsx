// src/components/MessageBubble.tsx

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
// highlight.js 按需注册语言（替代默认全量加载，节省 ~150KB）
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import java from 'highlight.js/lib/languages/java'
import go from 'highlight.js/lib/languages/go'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('java', java)
hljs.registerLanguage('go', go)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('markdown', markdown)

import { ToolStatus } from './ToolStatus'
import type { ChatMessage } from '../types'
import type { SubAgentInfo } from './SubAgentCard'

/** 格式化 token 数量：>1M 显示 M，>1K 显示 K，否则原始数字 */
const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

/** 图片预览组件：加载失败时显示占位提示 */
function ImagePreview({ imageId }: { imageId: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <span className="text-xs text-txt-secondary bg-elevated rounded px-2 py-1">图片已过期</span>
  }
  return (
    <img
      src={`/api/images/${imageId}`}
      alt="附件图片"
      className="max-w-[300px] max-h-[200px] rounded-lg border border-border cursor-pointer hover:opacity-80 transition-opacity"
      onClick={() => window.open(`/api/images/${imageId}`, '_blank')}
      onError={() => setFailed(true)}
    />
  )
}

interface Props {
  message: ChatMessage
  subAgents?: Map<string, SubAgentInfo>
}

export function MessageBubble({ message, subAgents }: Props) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const sourceTag = message.source === 'web' ? ' (web)' : message.source === 'cli' ? ' (cli)' : ''

  if (message.role === 'assistant') {
    console.log('[MessageBubble] rendering assistant msg:', message.id, 'content length:', message.content.length, 'first 100:', message.content.slice(0, 100))
  }

  if (isSystem && message.toolEvents && message.toolEvents.length > 0) {
    return (
      <div className="mb-2 px-2">
        <ToolStatus events={message.toolEvents} subAgents={subAgents} />
      </div>
    )
  }

  if (isSystem) {
    return (
      <div className="mb-3 px-2">
        <span className="text-xs text-txt-secondary">{message.content}</span>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[80%] rounded-lg px-4 py-3 ${
        isUser ? 'bg-accent text-white' : 'bg-surface border border-border text-txt-primary'
      }`}>
        {/* 来源标签（user） / 模型标签（assistant） */}
        {isUser && sourceTag && (
          <span className="text-xs opacity-50 mb-1 block">{sourceTag}</span>
        )}
        {!isUser && (message.model || message.provider) && (
          <span className="text-xs text-txt-secondary mb-1 block">
            {message.provider && <span className="bg-elevated px-1 py-0.5 rounded mr-1">{message.provider}</span>}
            {message.model && <span>{message.model}</span>}
          </span>
        )}
        {/* 思考过程折叠展示（仅 assistant） */}
        {!isUser && message.thinking && (
          <details className="mb-2">
            <summary className="text-xs text-warning/70 cursor-pointer select-none">
              💭 思考过程 ({message.thinking.length} 字)
            </summary>
            <div className="mt-1 p-2 bg-surface rounded text-xs text-txt-secondary whitespace-pre-wrap max-h-[200px] overflow-y-auto">
              {message.thinking}
            </div>
          </details>
        )}
        {isUser ? (
          <>
            <p className="whitespace-pre-wrap">{message.content}</p>
            {/* 用户消息附带的图片 */}
            {message.imageIds && message.imageIds.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {message.imageIds.map(id => (
                  <ImagePreview key={id} imageId={id} />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="prose dark:prose-invert prose-sm max-w-none prose-pre:bg-surface prose-pre:border prose-pre:border-border">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {/* token 统计底栏（仅 assistant 且有 usage 数据） */}
        {!isUser && message.usage && (
          <div className="mt-2 pt-2 border-t border-border/50 text-xs text-txt-secondary flex gap-3">
            <span>{fmtTokens(message.usage.inputTokens)} in / {fmtTokens(message.usage.outputTokens)} out</span>
            {message.llmCallCount && message.llmCallCount > 1 && <span>{message.llmCallCount} 次调用</span>}
            {message.toolCallCount && message.toolCallCount > 0 && <span>{message.toolCallCount} 次工具</span>}
          </div>
        )}
      </div>
    </div>
  )
}

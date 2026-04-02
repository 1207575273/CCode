// src/memory/core/compact-bridge.ts

/**
 * CompactBridge — Compact 与记忆系统的融合桥梁。
 *
 * 设计文档：§4.4
 *
 * 在 ContextManager 压缩上下文之前：
 * 1. extractAndSave() — 用 LLM 从即将被压缩的历史中提取关键信息，写入记忆
 * 2. getCompactHint() — 返回提示注入压缩后的上下文
 *
 * source: 'auto-summarize' 标记自动提取的记忆，用于去重。
 */

import type { Message } from '@core/types.js'
import type { LLMProvider } from '@providers/provider.js'
import type { IMemoryManager, MemoryEntry, MemoryType } from '@memory/types.js'

/** CompactBridge 接口 */
export interface ICompactBridge {
  extractAndSave(messages: Message[], provider: LLMProvider, model: string): Promise<MemoryEntry[]>
  getCompactHint(): string
}

/** 提取指令 */
const EXTRACT_SYSTEM = 'You are a knowledge extraction assistant. Extract important facts, decisions, and insights from the conversation.'

const EXTRACT_PROMPT = `From the conversation above, extract key information that should be remembered for future sessions. Output as JSON array:

[
  {
    "title": "brief title",
    "content": "detailed content",
    "type": "project|user|feedback|reference",
    "tags": ["tag1", "tag2"]
  }
]

Focus on:
- Architecture decisions and their rationale
- User preferences and coding style
- Important bugs found and how they were fixed
- Project constraints and requirements
- Technical debt and planned improvements

Only extract information that would be valuable in future conversations. Skip trivial or transient information. Output ONLY the JSON array, no other text.`

export class CompactBridge implements ICompactBridge {
  #memoryManager: IMemoryManager
  #lastExtractedCount = 0

  constructor(memoryManager: IMemoryManager) {
    this.#memoryManager = memoryManager
  }

  /**
   * 从即将压缩的历史中提取关键信息，写入记忆系统。
   *
   * 注意：这是一次 LLM 调用（与 compact 本身的摘要调用是分开的）。
   * 设计文档建议后续可合并为一次调用降低成本。
   */
  async extractAndSave(
    messages: Message[],
    provider: LLMProvider,
    model: string,
  ): Promise<MemoryEntry[]> {
    this.#lastExtractedCount = 0
    if (messages.length === 0) return []

    try {
      // 用 LLM 提取关键信息
      const extractMessages: Message[] = [
        ...messages,
        { role: 'user', content: EXTRACT_PROMPT },
      ]

      let rawOutput = ''
      for await (const chunk of provider.chat({
        model,
        messages: extractMessages,
        tools: [],
        systemPrompt: EXTRACT_SYSTEM,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          rawOutput += chunk.text
        }
      }

      // 解析 JSON 数组
      const entries = parseExtractedEntries(rawOutput)
      if (entries.length === 0) return []

      // 写入记忆系统
      const saved: MemoryEntry[] = []
      for (const entry of entries) {
        try {
          const result = await this.#memoryManager.write({
            scope: 'project',
            title: entry.title,
            content: entry.content,
            type: entry.type as MemoryType,
            tags: entry.tags,
            source: 'auto-summarize',
            filePath: '',
          })
          saved.push(result)
        } catch (err) {
          // 单条写入失败不影响其他
          console.warn('[Memory] CompactBridge: 单条记忆写入失败', err)
        }
      }

      this.#lastExtractedCount = saved.length
      return saved
    } catch (err) {
      // LLM 调用失败不影响 compact 流程
      console.warn('[Memory] CompactBridge: 提取关键信息失败', err)
      return []
    }
  }

  /** 返回注入压缩后上下文的提示 */
  getCompactHint(): string {
    if (this.#lastExtractedCount === 0) return ''
    return `[Note: ${this.#lastExtractedCount} key insights from the compressed conversation have been saved to the memory system. Use memory_search to retrieve them if needed.]`
  }
}

/** 从 LLM 输出中解析 JSON 数组 */
function parseExtractedEntries(raw: string): Array<{
  title: string
  content: string
  type: string
  tags: string[]
}> {
  try {
    // 找到 JSON 数组（可能被包裹在 markdown code block 中）
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    return parsed.filter(e =>
      typeof e.title === 'string' && e.title.trim() &&
      typeof e.content === 'string' && e.content.trim()
    ).map(e => ({
      title: e.title.trim(),
      content: e.content.trim(),
      type: ['project', 'user', 'feedback', 'reference'].includes(e.type) ? e.type : 'project',
      tags: Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === 'string') : [],
    }))
  } catch (err) {
    console.warn('[Memory] CompactBridge: 解析提取结果失败', err)
    return []
  }
}

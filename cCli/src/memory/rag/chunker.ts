// src/memory/rag/chunker.ts

/**
 * RecursiveCharacterChunker — 按 Markdown 层级分隔符递归切分文档。
 *
 * 设计文档：§3.7 文档切分
 *
 * 策略：
 * - 优先在标题/段落边界切割，保持语义完整性
 * - 小于 maxChunkSize 的文件不切分（文件即 chunk）
 * - 切分后相邻 chunk 有 overlap，保留上下文衔接
 */

import type { MemoryChunk } from '@memory/types.js'

/** 切分选项 */
export interface ChunkOptions {
  /** 单个 chunk 最大字符数（默认 2000，约 512 tokens） */
  maxChunkSize?: number
  /** 相邻 chunk 重叠字符数（默认 100） */
  overlap?: number
  /** 分隔符优先级列表（从高到低） */
  separators?: string[]
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  maxChunkSize: 2000,
  overlap: 100,
  separators: ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', ' '],
}

/**
 * 递归字符切分器。
 *
 * 对外唯一入口：chunkText() / chunkEntry()
 */
export class RecursiveCharacterChunker {
  private readonly options: Required<ChunkOptions>

  constructor(options?: ChunkOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * 将纯文本切分为 chunk 列表。
   * 小于 maxChunkSize 的文本不切分。
   */
  chunkText(text: string): string[] {
    const trimmed = text.trim()
    if (trimmed.length === 0) return []
    if (trimmed.length <= this.options.maxChunkSize) return [trimmed]
    return this.splitRecursive(trimmed, 0)
  }

  /**
   * 将文本切分为带 entryId 的 MemoryChunk 列表。
   */
  chunkEntry(entryId: string, text: string): MemoryChunk[] {
    const texts = this.chunkText(text)
    return texts.map((t, i) => ({
      id: `${entryId}_${i}`,
      entryId,
      text: t,
      chunkIndex: i,
    }))
  }

  /**
   * 递归切分核心逻辑。
   * 按当前优先级的分隔符拆分，超出大小的片段用下一级分隔符继续递归。
   */
  private splitRecursive(text: string, separatorIndex: number): string[] {
    const { maxChunkSize, overlap, separators } = this.options

    // 已经足够小
    if (text.length <= maxChunkSize) return [text]

    // 没有更多分隔符了，强制按字符数切割
    if (separatorIndex >= separators.length) {
      return this.splitBySize(text, maxChunkSize, overlap)
    }

    const separator = separators[separatorIndex]!
    const parts = this.splitKeepingSeparator(text, separator)

    // 当前分隔符没有切出多个片段，用下一级分隔符
    if (parts.length <= 1) {
      return this.splitRecursive(text, separatorIndex + 1)
    }

    // 合并小片段，确保每个 chunk 尽量接近 maxChunkSize
    const chunks: string[] = []
    let current = ''

    for (const part of parts) {
      if (current.length + part.length <= maxChunkSize) {
        current += part
      } else {
        if (current.length > 0) {
          chunks.push(current.trim())
        }
        // 单个 part 超过 maxChunkSize，递归切分
        if (part.length > maxChunkSize) {
          const subChunks = this.splitRecursive(part, separatorIndex + 1)
          chunks.push(...subChunks)
          current = ''
        } else {
          current = this.applyOverlap(chunks, part, overlap)
        }
      }
    }

    if (current.trim().length > 0) {
      chunks.push(current.trim())
    }

    return chunks.filter(c => c.length > 0)
  }

  /**
   * 按分隔符拆分，保留分隔符在下一段开头（标题类分隔符需保留）。
   */
  private splitKeepingSeparator(text: string, separator: string): string[] {
    const parts: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      // 跳过第一个字符再找分隔符，避免开头的分隔符产生空片段
      const idx = remaining.indexOf(separator, 1)
      if (idx === -1) {
        parts.push(remaining)
        break
      }
      parts.push(remaining.slice(0, idx))
      remaining = remaining.slice(idx)
    }

    return parts
  }

  /**
   * 强制按字符数切割（最后手段）。
   */
  private splitBySize(text: string, maxSize: number, overlap: number): string[] {
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      const end = Math.min(start + maxSize, text.length)
      chunks.push(text.slice(start, end).trim())
      start = end - overlap
      if (start >= text.length) break
      // 避免 overlap 导致无限循环
      if (end === text.length) break
    }
    return chunks.filter(c => c.length > 0)
  }

  /**
   * 从上一个 chunk 的末尾取 overlap 字符，拼接到当前 part 开头。
   */
  private applyOverlap(chunks: string[], part: string, overlap: number): string {
    if (chunks.length === 0 || overlap <= 0) return part
    const lastChunk = chunks[chunks.length - 1]!
    const overlapText = lastChunk.slice(-overlap)
    return overlapText + part
  }
}

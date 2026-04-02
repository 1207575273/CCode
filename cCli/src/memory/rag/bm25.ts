// src/memory/rag/bm25.ts

/**
 * BM25 倒排索引 — 纯 TypeScript 实现，零外部依赖。
 *
 * 设计文档：§3.6
 *
 * 特点：
 * - 基于内存的倒排索引，启动时从 chunk 文本构建
 * - 搜索时支持 scope/tags/type 过滤下推
 * - 依赖 tokenizer 进行中英文分词
 */

import type { Tokenizer, MemoryScope, MemoryType } from '@memory/types.js'

// ═══════════════════════════════════════════════
// BM25 参数
// ═══════════════════════════════════════════════

/** BM25 参数 k1：词频饱和度，越大 TF 影响越大 */
const K1 = 1.5
/** BM25 参数 b：文档长度归一化，0=不归一化，1=完全归一化 */
const B = 0.75

// ═══════════════════════════════════════════════
// 文档元数据
// ═══════════════════════════════════════════════

/** 索引中的文档 */
interface IndexedDoc {
  chunkId: string
  entryId: string
  text: string
  /** 分词后的 token 数量 */
  tokenCount: number
  /** 每个 token 的词频 */
  termFreqs: Map<string, number>
  /** 过滤字段 */
  scope: string
  tags: string[]
  type: string
}

/** BM25 搜索选项 */
export interface BM25SearchOptions {
  topK: number
  scope?: MemoryScope | 'all'
  tags?: string[]
  type?: MemoryType
}

/** BM25 搜索结果 */
export interface BM25SearchResult {
  chunkId: string
  entryId: string
  text: string
  score: number
}

// ═══════════════════════════════════════════════
// BM25Index
// ═══════════════════════════════════════════════

export class BM25Index {
  private tokenizer: Tokenizer
  /** chunkId → IndexedDoc */
  private docs = new Map<string, IndexedDoc>()
  /** term → Set<chunkId>（倒排表） */
  private invertedIndex = new Map<string, Set<string>>()
  /** 平均文档长度 */
  private avgDocLength = 0

  constructor(tokenizer: Tokenizer) {
    this.tokenizer = tokenizer
  }

  /** 文档总数 */
  get size(): number {
    return this.docs.size
  }

  /**
   * 添加文档到索引。
   */
  add(doc: {
    chunkId: string
    entryId: string
    text: string
    scope: string
    tags: string[]
    type: string
  }): void {
    // 如果已存在，先删除再重新添加
    if (this.docs.has(doc.chunkId)) {
      this.remove(doc.chunkId)
    }

    const tokens = this.tokenizer.tokenize(doc.text)
    const termFreqs = new Map<string, number>()
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1)
    }

    const indexed: IndexedDoc = {
      chunkId: doc.chunkId,
      entryId: doc.entryId,
      text: doc.text,
      tokenCount: tokens.length,
      termFreqs,
      scope: doc.scope,
      tags: doc.tags,
      type: doc.type,
    }

    this.docs.set(doc.chunkId, indexed)

    // 更新倒排表
    for (const term of termFreqs.keys()) {
      let postings = this.invertedIndex.get(term)
      if (!postings) {
        postings = new Set()
        this.invertedIndex.set(term, postings)
      }
      postings.add(doc.chunkId)
    }

    this.recalcAvgLength()
  }

  /**
   * 从索引中删除文档。
   */
  remove(chunkId: string): void {
    const doc = this.docs.get(chunkId)
    if (!doc) return

    // 从倒排表中移除
    for (const term of doc.termFreqs.keys()) {
      const postings = this.invertedIndex.get(term)
      if (postings) {
        postings.delete(chunkId)
        if (postings.size === 0) {
          this.invertedIndex.delete(term)
        }
      }
    }

    this.docs.delete(chunkId)
    this.recalcAvgLength()
  }

  /**
   * 删除指定 entryId 的所有 chunk。
   */
  removeByEntryId(entryId: string): void {
    const toRemove: string[] = []
    for (const [chunkId, doc] of this.docs) {
      if (doc.entryId === entryId) toRemove.push(chunkId)
    }
    for (const id of toRemove) {
      this.remove(id)
    }
  }

  /**
   * BM25 检索。
   * 过滤条件在计算前应用（过滤下推），不对不匹配的文档计算分数。
   */
  search(query: string, options: BM25SearchOptions): BM25SearchResult[] {
    const queryTokens = this.tokenizer.tokenize(query)
    if (queryTokens.length === 0) return []

    const N = this.docs.size
    if (N === 0) return []

    // 收集候选文档（至少包含一个查询 token 的文档）
    const candidates = new Set<string>()
    for (const token of queryTokens) {
      const postings = this.invertedIndex.get(token)
      if (postings) {
        for (const chunkId of postings) candidates.add(chunkId)
      }
    }

    const scored: BM25SearchResult[] = []

    for (const chunkId of candidates) {
      const doc = this.docs.get(chunkId)!

      // 过滤下推
      if (options.scope && options.scope !== 'all' && doc.scope !== options.scope) continue
      if (options.type && doc.type !== options.type) continue
      if (options.tags && options.tags.length > 0) {
        if (!options.tags.some(t => doc.tags.includes(t))) continue
      }

      // 计算 BM25 分数
      let score = 0
      for (const token of queryTokens) {
        const tf = doc.termFreqs.get(token) ?? 0
        if (tf === 0) continue

        // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        const df = this.invertedIndex.get(token)?.size ?? 0
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)

        // BM25 TF 归一化
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.tokenCount / this.avgDocLength))

        score += idf * tfNorm
      }

      if (score > 0) {
        scored.push({
          chunkId: doc.chunkId,
          entryId: doc.entryId,
          text: doc.text,
          score,
        })
      }
    }

    // 按分数降序排序
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, options.topK)
  }

  /** 清空索引 */
  clear(): void {
    this.docs.clear()
    this.invertedIndex.clear()
    this.avgDocLength = 0
  }

  /** 重新计算平均文档长度 */
  private recalcAvgLength(): void {
    if (this.docs.size === 0) {
      this.avgDocLength = 0
      return
    }
    let total = 0
    for (const doc of this.docs.values()) {
      total += doc.tokenCount
    }
    this.avgDocLength = total / this.docs.size
  }
}

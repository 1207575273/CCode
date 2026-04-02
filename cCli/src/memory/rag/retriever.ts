// src/memory/rag/retriever.ts

/**
 * Retriever — 混合检索器（BM25 + 向量 + RRF 融合）。
 *
 * 设计文档：§3.6
 *
 * 检索流水线：
 *   query + filters
 *     ├── BM25 关键词检索（带过滤下推）→ 候选集 A
 *     ├── Dense 向量检索（带过滤下推）→ 候选集 B
 *     │         ↓
 *     │   RRF 融合
 *     │         ↓
 *     │   Entry 级聚合去重
 *     │         ↓
 *     └── Top-K 结果 → MemorySearchResult[]
 */

import type {
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  MemoryChunk,
  EmbeddingProvider,
  IVectorStore,
} from '@memory/types.js'
import type { BM25Index } from './bm25.js'

/** RRF 常数，论文推荐 k=60 */
const RRF_K = 60

/** 混合检索中每个通道的扩大系数（取更多候选，过滤后再截断） */
const CHANNEL_EXPAND = 3

export class Retriever {
  private embedding: EmbeddingProvider
  private vectorStore: IVectorStore | null
  private bm25: BM25Index
  /** entryId → MemoryEntry 的映射，由外部注入 */
  private entryMap: Map<string, MemoryEntry>

  constructor(options: {
    embedding: EmbeddingProvider
    vectorStore: IVectorStore | null
    bm25: BM25Index
    entryMap: Map<string, MemoryEntry>
  }) {
    this.embedding = options.embedding
    this.vectorStore = options.vectorStore
    this.bm25 = options.bm25
    this.entryMap = options.entryMap
  }

  /** 更新 entryMap 引用（entries 变化时调用） */
  setEntryMap(entryMap: Map<string, MemoryEntry>): void {
    this.entryMap = entryMap
  }

  /**
   * 混合检索。
   *
   * Embedding 可用 → BM25 + 向量 + RRF 融合
   * Embedding 不可用 → 纯 BM25
   */
  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const topK = query.topK ?? 5
    const channelK = topK * CHANNEL_EXPAND

    // 构建过滤选项（处理 exactOptionalPropertyTypes）
    const filterOpts = {
      topK: channelK,
      ...(query.scope !== undefined ? { scope: query.scope } : {}),
      ...(query.tags !== undefined ? { tags: query.tags } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
    }

    // BM25 通道（始终执行）
    const bm25Results = this.bm25.search(query.query, filterOpts)

    // 向量通道（Embedding 可用时执行）
    let vectorResults: Array<{ chunkId: string; entryId: string; text: string; score: number }> = []
    const embeddingAvailable = await this.embedding.isAvailable()

    if (embeddingAvailable && this.vectorStore) {
      try {
        const queryEmbedding = await this.embedding.embed(query.query)
        vectorResults = await this.vectorStore.similaritySearch(queryEmbedding, filterOpts)
      } catch {
        // Embedding 调用失败，降级为纯 BM25
      }
    }

    // RRF 融合
    const fused = this.rrfFusion(bm25Results, vectorResults)

    // Entry 级聚合去重
    const aggregated = this.aggregateByEntry(fused)

    // dateRange 过滤（在聚合后应用，因为 BM25 和 VectorStore 不直接支持）
    const filtered = query.dateRange
      ? aggregated.filter(r => {
        const updated = r.entry.updated
        if (query.dateRange!.from && updated < query.dateRange!.from) return false
        if (query.dateRange!.to && updated > query.dateRange!.to) return false
        return true
      })
      : aggregated

    return filtered.slice(0, topK)
  }

  /**
   * RRF（Reciprocal Rank Fusion）融合。
   *
   * 公式：RRF_score(d) = Σ 1/(k + rank_i(d))
   */
  private rrfFusion(
    bm25Results: Array<{ chunkId: string; entryId: string; text: string; score: number }>,
    vectorResults: Array<{ chunkId: string; entryId: string; text: string; score: number }>,
  ): Array<{ chunkId: string; entryId: string; text: string; rrfScore: number }> {
    const scoreMap = new Map<string, { chunkId: string; entryId: string; text: string; rrfScore: number }>()

    // BM25 排名贡献
    for (let rank = 0; rank < bm25Results.length; rank++) {
      const r = bm25Results[rank]!
      const existing = scoreMap.get(r.chunkId)
      const contribution = 1 / (RRF_K + rank + 1)
      if (existing) {
        existing.rrfScore += contribution
      } else {
        scoreMap.set(r.chunkId, { chunkId: r.chunkId, entryId: r.entryId, text: r.text, rrfScore: contribution })
      }
    }

    // 向量排名贡献
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const r = vectorResults[rank]!
      const existing = scoreMap.get(r.chunkId)
      const contribution = 1 / (RRF_K + rank + 1)
      if (existing) {
        existing.rrfScore += contribution
      } else {
        scoreMap.set(r.chunkId, { chunkId: r.chunkId, entryId: r.entryId, text: r.text, rrfScore: contribution })
      }
    }

    // 按 RRF 分数降序
    return [...scoreMap.values()].sort((a, b) => b.rrfScore - a.rrfScore)
  }

  /**
   * Entry 级聚合去重。
   *
   * 同一 entry_id 的多个 chunk 合并为一条结果：
   * - score = 组内最高 RRF 分数
   * - snippet = 最高分 chunk 的文本
   * - matchedChunks = 该 entry 的所有命中 chunk
   */
  private aggregateByEntry(
    fused: Array<{ chunkId: string; entryId: string; text: string; rrfScore: number }>,
  ): MemorySearchResult[] {
    const groups = new Map<string, {
      maxScore: number
      bestText: string
      chunks: MemoryChunk[]
    }>()

    for (const item of fused) {
      const group = groups.get(item.entryId)
      const chunk: MemoryChunk = {
        id: item.chunkId,
        entryId: item.entryId,
        text: item.text,
        chunkIndex: this.parseChunkIndex(item.chunkId),
      }

      if (group) {
        group.chunks.push(chunk)
        if (item.rrfScore > group.maxScore) {
          group.maxScore = item.rrfScore
          group.bestText = item.text
        }
      } else {
        groups.set(item.entryId, {
          maxScore: item.rrfScore,
          bestText: item.text,
          chunks: [chunk],
        })
      }
    }

    // 转换为 MemorySearchResult，按 score 降序
    const results: MemorySearchResult[] = []
    for (const [entryId, group] of groups) {
      const entry = this.entryMap.get(entryId)
      if (!entry) continue

      // 归一化 score 到 0-1（最高分 = 1）
      results.push({
        entry,
        score: group.maxScore,
        snippet: group.bestText.slice(0, 200),
        matchedChunks: group.chunks,
      })
    }

    results.sort((a, b) => b.score - a.score)

    // 归一化：最高分映射为 1
    if (results.length > 0 && results[0]!.score > 0) {
      const maxScore = results[0]!.score
      for (const r of results) {
        r.score = r.score / maxScore
      }
    }

    return results
  }

  /** 从 chunkId (格式 entryId_N) 解析 chunkIndex */
  private parseChunkIndex(chunkId: string): number {
    const lastUnderscore = chunkId.lastIndexOf('_')
    if (lastUnderscore === -1) return 0
    const num = parseInt(chunkId.slice(lastUnderscore + 1), 10)
    return isNaN(num) ? 0 : num
  }
}

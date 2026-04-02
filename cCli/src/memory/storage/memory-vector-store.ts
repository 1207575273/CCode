// src/memory/storage/memory-vector-store.ts

/**
 * MemoryVectorStore — 纯内存 IVectorStore 实现，用于单元测试。
 *
 * 暴力余弦相似度计算，不依赖 libsql。
 */

import type { IVectorStore, VectorChunkInput, VectorSearchHit, VectorSearchOptions, MemoryScope } from '@memory/types.js'

interface StoredChunk {
  id: string
  entryId: string
  embedding: number[]
  text: string
  chunkIndex: number
  scope: string
  projectSlug: string | undefined
  tags: string[]
  type: string
  source: string
  created: string
  updated: string
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export class MemoryVectorStore implements IVectorStore {
  readonly dimension: number
  private chunks = new Map<string, StoredChunk>()

  constructor(dimension: number) {
    this.dimension = dimension
  }

  async initialize(): Promise<void> {
    // 纯内存，无需初始化
  }

  async upsert(chunks: VectorChunkInput[]): Promise<void> {
    for (const c of chunks) {
      this.chunks.set(c.id, {
        id: c.id,
        entryId: c.entryId,
        embedding: c.embedding,
        text: c.text,
        chunkIndex: c.chunkIndex,
        scope: c.scope,
        projectSlug: c.projectSlug,
        tags: c.tags,
        type: c.type,
        source: c.source,
        created: c.created,
        updated: c.updated,
      })
    }
  }

  async deleteByEntryId(entryId: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.entryId === entryId) {
        this.chunks.delete(id)
      }
    }
  }

  async similaritySearch(queryEmbedding: number[], options: VectorSearchOptions): Promise<VectorSearchHit[]> {
    const scored: Array<{ chunk: StoredChunk; score: number }> = []

    for (const chunk of this.chunks.values()) {
      // 过滤下推
      if (options.scope && options.scope !== 'all' && chunk.scope !== options.scope) continue
      if (options.type && chunk.type !== options.type) continue
      if (options.tags && options.tags.length > 0) {
        if (!options.tags.some(t => chunk.tags.includes(t))) continue
      }

      const score = cosineSimilarity(queryEmbedding, chunk.embedding)
      scored.push({ chunk, score })
    }

    // 按相似度降序排序
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, options.topK).map(({ chunk, score }) => ({
      chunkId: chunk.id,
      entryId: chunk.entryId,
      text: chunk.text,
      score,
    }))
  }

  async getChunkTexts(scope?: MemoryScope): Promise<Array<{ chunkId: string; text: string; entryId: string }>> {
    const result: Array<{ chunkId: string; text: string; entryId: string }> = []
    for (const chunk of this.chunks.values()) {
      if (scope && chunk.scope !== scope) continue
      result.push({ chunkId: chunk.id, text: chunk.text, entryId: chunk.entryId })
    }
    return result
  }

  async clear(): Promise<void> {
    this.chunks.clear()
  }

  async close(): Promise<void> {
    this.chunks.clear()
  }
}

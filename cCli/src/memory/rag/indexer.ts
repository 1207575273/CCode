// src/memory/rag/indexer.ts

/**
 * Indexer — 离线索引编排器。
 *
 * 设计文档：§5.1
 *
 * 编排流程：
 *   MemoryEntry[] → Chunker.chunk → EmbeddingProvider.embedBatch → VectorStore.upsert + BM25.add
 *
 * 增量策略：基于 updated 时间戳判断是否需要重新索引。
 * "外部 IO 不上热路径"原则：embed 是异步的，BM25 是同步的。
 */

import type { MemoryEntry, MemoryChunk, EmbeddingProvider, IVectorStore, VectorChunkInput } from '@memory/types.js'
import type { BM25Index } from './bm25.js'
import { RecursiveCharacterChunker } from './chunker.js'

/** 索引构建结果 */
export interface IndexBuildResult {
  /** 总 entry 数 */
  totalEntries: number
  /** 总 chunk 数 */
  totalChunks: number
  /** 新增/更新的 entry 数 */
  indexedEntries: number
  /** 跳过的 entry 数（已是最新） */
  skippedEntries: number
  /** embed 是否执行（false = 纯 BM25 模式） */
  embeddingDone: boolean
}

export class Indexer {
  private chunker: RecursiveCharacterChunker
  private embedding: EmbeddingProvider
  private vectorStore: IVectorStore | null
  private bm25: BM25Index

  /** 已索引 entry 的 updated 时间戳缓存，用于增量判断 */
  private indexedTimestamps = new Map<string, string>()

  constructor(options: {
    embedding: EmbeddingProvider
    vectorStore: IVectorStore | null
    bm25: BM25Index
    chunker?: RecursiveCharacterChunker
  }) {
    this.embedding = options.embedding
    this.vectorStore = options.vectorStore
    this.bm25 = options.bm25
    this.chunker = options.chunker ?? new RecursiveCharacterChunker()
  }

  /**
   * 全量构建索引（启动时同步阶段）。
   *
   * 只构建 BM25（内存操作，毫秒级），不做 embed。
   * 返回需要 embed 的 pending chunks 供异步阶段处理。
   */
  buildBM25(entries: MemoryEntry[]): { chunks: MemoryChunk[]; pendingEntries: MemoryEntry[] } {
    const allChunks: MemoryChunk[] = []
    const pendingEntries: MemoryEntry[] = []

    for (const entry of entries) {
      const chunks = this.chunker.chunkEntry(entry.id, entry.content)
      allChunks.push(...chunks)

      // 添加到 BM25 索引
      for (const chunk of chunks) {
        this.bm25.add({
          chunkId: chunk.id,
          entryId: chunk.entryId,
          text: chunk.text,
          scope: entry.scope,
          tags: entry.tags,
          type: entry.type,
        })
      }

      // 检查是否需要重新 embed
      const lastIndexed = this.indexedTimestamps.get(entry.id)
      if (!lastIndexed || lastIndexed !== entry.updated) {
        pendingEntries.push(entry)
      }

      this.indexedTimestamps.set(entry.id, entry.updated)
    }

    return { chunks: allChunks, pendingEntries }
  }

  /**
   * 异步 embed + 写入向量存储（启动后台阶段）。
   *
   * 遵循"外部 IO 不上热路径"原则，不阻塞启动。
   */
  async embedAndUpsert(entries: MemoryEntry[], projectSlug?: string): Promise<IndexBuildResult> {
    const embeddingAvailable = await this.embedding.isAvailable()
    let indexedEntries = 0
    let totalChunks = 0
    const skippedEntries = 0

    for (const entry of entries) {
      const chunks = this.chunker.chunkEntry(entry.id, entry.content)
      totalChunks += chunks.length

      if (embeddingAvailable && this.vectorStore) {
        // embed + 写入向量存储
        const texts = chunks.map(c => c.text)
        const embeddings = await this.embedding.embedBatch(texts)

        const vectorChunks: VectorChunkInput[] = chunks.map((c, i) => ({
          id: c.id,
          entryId: c.entryId,
          embedding: embeddings[i]!,
          text: c.text,
          chunkIndex: c.chunkIndex,
          scope: entry.scope,
          ...(projectSlug !== undefined ? { projectSlug } : {}),
          tags: entry.tags,
          type: entry.type,
          source: entry.source,
          created: entry.created,
          updated: entry.updated,
        }))

        await this.vectorStore.upsert(vectorChunks)
      }

      indexedEntries++
    }

    return {
      totalEntries: entries.length,
      totalChunks,
      indexedEntries,
      skippedEntries,
      embeddingDone: embeddingAvailable,
    }
  }

  /**
   * 单条 entry 即时索引（memory_write 时调用）。
   *
   * BM25 同步更新，embed 异步返回 Promise（调用方决定是否 await）。
   */
  upsertEntry(entry: MemoryEntry, projectSlug?: string): { embedPromise: Promise<void> } {
    // 先删除旧索引
    this.bm25.removeByEntryId(entry.id)

    // 切分 + BM25 同步更新
    const chunks = this.chunker.chunkEntry(entry.id, entry.content)
    for (const chunk of chunks) {
      this.bm25.add({
        chunkId: chunk.id,
        entryId: chunk.entryId,
        text: chunk.text,
        scope: entry.scope,
        tags: entry.tags,
        type: entry.type,
      })
    }

    this.indexedTimestamps.set(entry.id, entry.updated)

    // embed 异步（不阻塞调用方）
    const embedPromise = (async () => {
      const embeddingAvailable = await this.embedding.isAvailable()
      if (!embeddingAvailable || !this.vectorStore) return

      // 先删除旧向量
      await this.vectorStore.deleteByEntryId(entry.id)

      const texts = chunks.map(c => c.text)
      const embeddings = await this.embedding.embedBatch(texts)

      const vectorChunks: VectorChunkInput[] = chunks.map((c, i) => ({
        id: c.id,
        entryId: c.entryId,
        embedding: embeddings[i]!,
        text: c.text,
        chunkIndex: c.chunkIndex,
        scope: entry.scope,
        ...(projectSlug !== undefined ? { projectSlug } : {}),
        tags: entry.tags,
        type: entry.type,
        source: entry.source,
        created: entry.created,
        updated: entry.updated,
      }))

      await this.vectorStore.upsert(vectorChunks)
    })()

    return { embedPromise }
  }

  /**
   * 删除 entry 的所有索引。
   */
  async removeEntry(entryId: string): Promise<void> {
    this.bm25.removeByEntryId(entryId)
    if (this.vectorStore) {
      await this.vectorStore.deleteByEntryId(entryId)
    }
    this.indexedTimestamps.delete(entryId)
  }
}

import { describe, it, expect, beforeEach } from 'vitest'
import { Retriever } from '@memory/rag/retriever.js'
import { BM25Index } from '@memory/rag/bm25.js'
import { Indexer } from '@memory/rag/indexer.js'
import { MemoryVectorStore } from '@memory/storage/memory-vector-store.js'
import { NoopEmbedding } from '@memory/rag/embedding/noop-embedding.js'
import { JiebaTokenizer } from '@memory/rag/tokenizer.js'
import type { MemoryEntry, EmbeddingProvider } from '@memory/types.js'

// ═══════════════════════════════════════════════
// Mock Embedding（返回确定性向量，便于测试）
// ═══════════════════════════════════════════════

const DIM = 8

/** 简单的确定性 Embedding：基于文本 hash 生成归一化向量 */
class MockEmbedding implements EmbeddingProvider {
  readonly name = 'mock'
  readonly dimension = DIM
  readonly maxBatchSize = 20

  async embed(text: string): Promise<number[]> {
    return this.deterministicVec(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.deterministicVec(t))
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  private deterministicVec(text: string): number[] {
    // 简单 hash → 向量（相似文本产生相似向量）
    const v = new Array(DIM).fill(0) as number[]
    for (let i = 0; i < text.length; i++) {
      v[i % DIM]! += text.charCodeAt(i)
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return v.map(x => x / (norm || 1))
  }
}

// ═══════════════════════════════════════════════
// 测试 Entries
// ═══════════════════════════════════════════════

function makeEntry(id: string, title: string, content: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id,
    scope: 'project',
    title,
    content,
    type: 'project',
    tags: [],
    source: 'agent',
    created: '2026-04-01T00:00:00Z',
    updated: '2026-04-01T00:00:00Z',
    filePath: `/tmp/${id}.md`,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════

describe('Retriever', () => {

  describe('纯 BM25 模式（Embedding 不可用）', () => {
    let retriever: Retriever
    let entryMap: Map<string, MemoryEntry>

    beforeEach(() => {
      const tokenizer = new JiebaTokenizer()
      const bm25 = new BM25Index(tokenizer)
      entryMap = new Map()

      const entries = [
        makeEntry('e1', '认证中间件', '认证中间件需要重写以满足合规要求'),
        makeEntry('e2', 'React组件', '前端组件需要使用React函数组件风格'),
        makeEntry('e3', '数据库优化', '数据库索引优化提升查询性能'),
      ]
      for (const e of entries) {
        entryMap.set(e.id, e)
        bm25.add({ chunkId: `${e.id}_0`, entryId: e.id, text: e.content, scope: e.scope, tags: e.tags, type: e.type })
      }

      retriever = new Retriever({
        embedding: new NoopEmbedding(),
        vectorStore: null,
        bm25,
        entryMap,
      })
    })

    it('纯 BM25 检索返回正确结果', async () => {
      const results = await retriever.search({ query: '认证中间件', topK: 3 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.entry.id).toBe('e1')
      expect(results[0]!.score).toBeCloseTo(1, 1) // 归一化后最高分 = 1
    })

    it('无匹配返回空', async () => {
      const results = await retriever.search({ query: '量子力学', topK: 3 })
      expect(results).toEqual([])
    })
  })

  describe('混合检索（BM25 + 向量）', () => {
    let retriever: Retriever
    let entryMap: Map<string, MemoryEntry>

    beforeEach(async () => {
      const tokenizer = new JiebaTokenizer()
      const bm25 = new BM25Index(tokenizer)
      const mockEmbed = new MockEmbedding()
      const vectorStore = new MemoryVectorStore(DIM)
      await vectorStore.initialize()
      entryMap = new Map()

      const entries = [
        makeEntry('e1', '认证中间件', '认证中间件需要重写以满足合规要求', { tags: ['auth'] }),
        makeEntry('e2', 'React组件', '前端组件需要使用React函数组件风格', { tags: ['frontend'] }),
        makeEntry('e3', '数据库优化', '数据库索引优化提升查询性能', { tags: ['db'] }),
      ]

      const indexer = new Indexer({ embedding: mockEmbed, vectorStore, bm25 })
      indexer.buildBM25(entries)
      await indexer.embedAndUpsert(entries)

      for (const e of entries) entryMap.set(e.id, e)

      retriever = new Retriever({ embedding: mockEmbed, vectorStore, bm25, entryMap })
    })

    it('RRF 融合返回结果', async () => {
      const results = await retriever.search({ query: '认证中间件重写', topK: 3 })
      expect(results.length).toBeGreaterThan(0)
      // e1 应该排在最前（BM25 和向量都命中）
      expect(results[0]!.entry.id).toBe('e1')
    })

    it('score 归一化到 0-1', async () => {
      const results = await retriever.search({ query: '认证', topK: 3 })
      if (results.length > 0) {
        expect(results[0]!.score).toBeCloseTo(1, 1)
        for (const r of results) {
          expect(r.score).toBeGreaterThanOrEqual(0)
          expect(r.score).toBeLessThanOrEqual(1)
        }
      }
    })

    it('tags 过滤下推', async () => {
      const results = await retriever.search({ query: '优化', topK: 5, tags: ['db'] })
      for (const r of results) {
        expect(r.entry.tags).toContain('db')
      }
    })

    it('snippet 不超过 200 字符', async () => {
      const results = await retriever.search({ query: '认证', topK: 3 })
      for (const r of results) {
        expect(r.snippet.length).toBeLessThanOrEqual(200)
      }
    })
  })

  describe('Entry 级去重', () => {
    it('同一 entry 的多个 chunk 合并为一条结果', async () => {
      const tokenizer = new JiebaTokenizer()
      const bm25 = new BM25Index(tokenizer)
      const entryMap = new Map<string, MemoryEntry>()

      const entry = makeEntry('e1', '长文档', '认证中间件第一部分内容介绍')
      entryMap.set('e1', entry)

      // 模拟同一 entry 被切成 2 个 chunk
      bm25.add({ chunkId: 'e1_0', entryId: 'e1', text: '认证中间件第一部分', scope: 'project', tags: [], type: 'project' })
      bm25.add({ chunkId: 'e1_1', entryId: 'e1', text: '认证中间件第二部分', scope: 'project', tags: [], type: 'project' })

      const retriever = new Retriever({
        embedding: new NoopEmbedding(),
        vectorStore: null,
        bm25,
        entryMap,
      })

      const results = await retriever.search({ query: '认证中间件', topK: 5 })
      // 应该只返回 1 条结果（e1），不是 2 条
      expect(results).toHaveLength(1)
      expect(results[0]!.entry.id).toBe('e1')
      // matchedChunks 应该包含 2 个 chunk
      expect(results[0]!.matchedChunks.length).toBe(2)
    })
  })

  describe('Indexer', () => {
    it('buildBM25 同步构建索引', () => {
      const tokenizer = new JiebaTokenizer()
      const bm25 = new BM25Index(tokenizer)
      const indexer = new Indexer({ embedding: new NoopEmbedding(), vectorStore: null, bm25 })

      const entries = [
        makeEntry('e1', '测试', '这是测试内容'),
        makeEntry('e2', '测试2', '另一段内容'),
      ]

      const { chunks, pendingEntries } = indexer.buildBM25(entries)
      expect(chunks.length).toBe(2) // 短文本不切分，1 entry = 1 chunk
      expect(pendingEntries.length).toBe(2) // 首次构建，全部 pending
      expect(bm25.size).toBe(2)
    })

    it('upsertEntry BM25 同步 + embed 异步', async () => {
      const tokenizer = new JiebaTokenizer()
      const bm25 = new BM25Index(tokenizer)
      const mockEmbed = new MockEmbedding()
      const vectorStore = new MemoryVectorStore(DIM)
      await vectorStore.initialize()

      const indexer = new Indexer({ embedding: mockEmbed, vectorStore, bm25 })

      const entry = makeEntry('e1', '认证', '认证中间件设计文档')
      const { embedPromise } = indexer.upsertEntry(entry)

      // BM25 立即可搜
      expect(bm25.search('认证', { topK: 1 }).length).toBe(1)

      // 向量异步完成后也可搜
      await embedPromise
      const vecResults = await vectorStore.getChunkTexts()
      expect(vecResults.length).toBe(1)
    })

    it('removeEntry 同时清理 BM25 和向量', async () => {
      const tokenizer = new JiebaTokenizer()
      const bm25 = new BM25Index(tokenizer)
      const mockEmbed = new MockEmbedding()
      const vectorStore = new MemoryVectorStore(DIM)
      await vectorStore.initialize()

      const indexer = new Indexer({ embedding: mockEmbed, vectorStore, bm25 })
      const entry = makeEntry('e1', '认证', '认证中间件设计文档')
      const { embedPromise } = indexer.upsertEntry(entry)
      await embedPromise

      await indexer.removeEntry('e1')
      expect(bm25.size).toBe(0)
      expect((await vectorStore.getChunkTexts()).length).toBe(0)
    })
  })
})

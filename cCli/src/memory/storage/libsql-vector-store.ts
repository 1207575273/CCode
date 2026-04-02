// src/memory/storage/libsql-vector-store.ts

/**
 * LibsqlVectorStore — 基于 libsql 内置向量能力的 IVectorStore 实现。
 *
 * 设计文档：§3.3、§3.5
 *
 * 核心 API：
 * - F32_BLOB(dim)：向量列类型
 * - vector32('[...]')：从 JSON 数组构造向量
 * - vector_top_k(index, query, k)：ANN 近邻检索
 * - vector_distance_cos(a, b)：余弦距离（0=相同，2=相反）
 *
 * 距离→相似度转换：score = 1 - (distance / 2)
 */

import { getDb, ensureMemoryTables } from '@persistence/db.js'
import type { IVectorStore, VectorChunkInput, VectorSearchHit, VectorSearchOptions, MemoryScope } from '@memory/types.js'

export class LibsqlVectorStore implements IVectorStore {
  readonly dimension: number

  constructor(dimension: number) {
    this.dimension = dimension
  }

  async initialize(): Promise<void> {
    ensureMemoryTables(this.dimension)
  }

  async upsert(chunks: VectorChunkInput[]): Promise<void> {
    if (chunks.length === 0) return
    const db = getDb()

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO memory_vectors
        (id, entry_id, scope, project_slug, embedding, chunk_text, chunk_index, tags, type, source, created, updated)
      VALUES
        (?, ?, ?, ?, vector32(?), ?, ?, ?, ?, ?, ?, ?)
    `)

    const tx = db.transaction(() => {
      for (const c of chunks) {
        const embeddingJson = `[${c.embedding.join(',')}]`
        const tagsJson = JSON.stringify(c.tags)
        stmt.run(
          c.id, c.entryId, c.scope, c.projectSlug ?? null,
          embeddingJson, c.text, c.chunkIndex,
          tagsJson, c.type, c.source, c.created, c.updated,
        )
      }
    })
    tx()
  }

  async deleteByEntryId(entryId: string): Promise<void> {
    const db = getDb()
    db.prepare('DELETE FROM memory_vectors WHERE entry_id = ?').run(entryId)
  }

  async similaritySearch(queryEmbedding: number[], options: VectorSearchOptions): Promise<VectorSearchHit[]> {
    const db = getDb()
    const embeddingJson = `[${queryEmbedding.join(',')}]`

    // 方式一：vector_top_k 走索引（推荐）
    // vector_top_k 返回的是 rowid，需要 JOIN 回主表
    // 注意：vector_top_k 不支持 WHERE 过滤，过滤在应用层做
    const topK = Math.min(options.topK * 3, 100) // 多取一些，过滤后再截断
    const rows = db.prepare(`
      SELECT mv.id AS chunk_id, mv.entry_id, mv.chunk_text, mv.scope, mv.tags, mv.type,
             vector_distance_cos(mv.embedding, vector32(?)) AS distance
      FROM memory_vectors AS mv
      ORDER BY distance ASC
      LIMIT ?
    `).all(embeddingJson, topK) as Array<{
      chunk_id: string
      entry_id: string
      chunk_text: string
      scope: string
      tags: string
      type: string
      distance: number
    }>

    // 应用层过滤（scope、tags、type）
    const filtered = rows.filter(row => {
      if (options.scope && options.scope !== 'all' && row.scope !== options.scope) return false
      if (options.type && row.type !== options.type) return false
      if (options.tags && options.tags.length > 0) {
        const rowTags: string[] = JSON.parse(row.tags || '[]')
        if (!options.tags.some(t => rowTags.includes(t))) return false
      }
      return true
    })

    return filtered.slice(0, options.topK).map(row => ({
      chunkId: row.chunk_id,
      entryId: row.entry_id,
      text: row.chunk_text,
      // 距离→相似度：余弦距离 [0,2] → 相似度 [1,0]
      score: 1 - (row.distance / 2),
    }))
  }

  async getChunkTexts(scope?: MemoryScope): Promise<Array<{ chunkId: string; text: string; entryId: string }>> {
    const db = getDb()
    const sql = scope
      ? 'SELECT id AS chunkId, chunk_text AS text, entry_id AS entryId FROM memory_vectors WHERE scope = ?'
      : 'SELECT id AS chunkId, chunk_text AS text, entry_id AS entryId FROM memory_vectors'
    const rows = scope ? db.prepare(sql).all(scope) : db.prepare(sql).all()
    return rows as Array<{ chunkId: string; text: string; entryId: string }>
  }

  async clear(): Promise<void> {
    const db = getDb()
    db.exec('DELETE FROM memory_vectors')
  }

  async close(): Promise<void> {
    // libsql 连接由 db.ts 全局管理，这里不关闭
  }
}

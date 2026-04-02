// src/memory/rag/embedding/noop-embedding.ts

/**
 * NoopEmbedding — Embedding 不可用时的降级实现。
 *
 * isAvailable() 始终返回 false，embed/embedBatch 抛错。
 * 用于纯 BM25 模式。
 */

import type { EmbeddingProvider } from '@memory/types.js'

export class NoopEmbedding implements EmbeddingProvider {
  readonly name = 'noop'
  readonly dimension = 0
  readonly maxBatchSize = 0

  async embed(): Promise<number[]> {
    throw new Error('Embedding 不可用（未配置或协议不支持），当前为纯 BM25 模式')
  }

  async embedBatch(): Promise<number[][]> {
    throw new Error('Embedding 不可用（未配置或协议不支持），当前为纯 BM25 模式')
  }

  async isAvailable(): Promise<boolean> {
    return false
  }
}

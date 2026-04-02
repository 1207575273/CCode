import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryVectorStore } from '@memory/storage/memory-vector-store.js'
import type { VectorChunkInput } from '@memory/types.js'

/** 生成简单的测试向量 */
function makeVec(dim: number, seed: number): number[] {
  const v = new Array(dim).fill(0)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1))
  }
  // 归一化
  const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0))
  return v.map((x: number) => x / norm)
}

function makeChunk(id: string, entryId: string, embedding: number[], overrides?: Partial<VectorChunkInput>): VectorChunkInput {
  return {
    id,
    entryId,
    embedding,
    text: `chunk text for ${id}`,
    chunkIndex: 0,
    scope: 'project',
    tags: [],
    type: 'project',
    source: 'agent',
    created: '2026-04-01T00:00:00Z',
    updated: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('MemoryVectorStore', () => {
  const DIM = 8
  let store: MemoryVectorStore

  beforeEach(async () => {
    store = new MemoryVectorStore(DIM)
    await store.initialize()
  })

  it('upsert + similaritySearch 基础流程', async () => {
    const v1 = makeVec(DIM, 1)
    const v2 = makeVec(DIM, 2)
    await store.upsert([
      makeChunk('c1', 'e1', v1),
      makeChunk('c2', 'e2', v2),
    ])

    // 用 v1 查询，应该 c1 排第一
    const results = await store.similaritySearch(v1, { topK: 2 })
    expect(results).toHaveLength(2)
    expect(results[0]!.chunkId).toBe('c1')
    expect(results[0]!.score).toBeCloseTo(1.0, 1) // 自身相似度接近 1
  })

  it('scope 过滤', async () => {
    await store.upsert([
      makeChunk('c1', 'e1', makeVec(DIM, 1), { scope: 'global' }),
      makeChunk('c2', 'e2', makeVec(DIM, 1.1), { scope: 'project' }),
    ])

    const results = await store.similaritySearch(makeVec(DIM, 1), { topK: 5, scope: 'global' })
    expect(results).toHaveLength(1)
    expect(results[0]!.chunkId).toBe('c1')
  })

  it('tags 过滤', async () => {
    await store.upsert([
      makeChunk('c1', 'e1', makeVec(DIM, 1), { tags: ['auth'] }),
      makeChunk('c2', 'e2', makeVec(DIM, 1.1), { tags: ['frontend'] }),
    ])

    const results = await store.similaritySearch(makeVec(DIM, 1), { topK: 5, tags: ['auth'] })
    expect(results).toHaveLength(1)
    expect(results[0]!.chunkId).toBe('c1')
  })

  it('deleteByEntryId', async () => {
    await store.upsert([
      makeChunk('e1_0', 'e1', makeVec(DIM, 1)),
      makeChunk('e1_1', 'e1', makeVec(DIM, 1.5)),
      makeChunk('e2_0', 'e2', makeVec(DIM, 2)),
    ])

    await store.deleteByEntryId('e1')
    const texts = await store.getChunkTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]!.entryId).toBe('e2')
  })

  it('getChunkTexts with scope filter', async () => {
    await store.upsert([
      makeChunk('c1', 'e1', makeVec(DIM, 1), { scope: 'global' }),
      makeChunk('c2', 'e2', makeVec(DIM, 2), { scope: 'project' }),
    ])

    const global = await store.getChunkTexts('global')
    expect(global).toHaveLength(1)
    expect(global[0]!.entryId).toBe('e1')

    const all = await store.getChunkTexts()
    expect(all).toHaveLength(2)
  })

  it('clear 清空', async () => {
    await store.upsert([makeChunk('c1', 'e1', makeVec(DIM, 1))])
    await store.clear()
    const texts = await store.getChunkTexts()
    expect(texts).toHaveLength(0)
  })

  it('upsert 同 ID 覆盖', async () => {
    await store.upsert([makeChunk('c1', 'e1', makeVec(DIM, 1))])
    await store.upsert([makeChunk('c1', 'e1', makeVec(DIM, 2))])
    const texts = await store.getChunkTexts()
    expect(texts).toHaveLength(1)
  })
})

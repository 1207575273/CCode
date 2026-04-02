// src/memory/index.ts

/**
 * 记忆系统模块入口。
 *
 * Phase 1 导出：类型 + 基础层（tokenizer、chunker、file-store）
 * Phase 2-5 逐步增加：VectorStore、BM25、Retriever、MemoryManager 等
 */

// 类型
export type {
  MemoryScope,
  MemoryType,
  MemorySource,
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  MemoryChunk,
  MemoryFrontmatter,
  IFileStore,
  IVectorStore,
  IMemoryManager,
  ICompactBridge,
  EmbeddingProvider,
  Tokenizer,
  VectorChunkInput,
  VectorSearchHit,
  VectorSearchOptions,
} from './types.js'

// 分词器
export { JiebaTokenizer, BigramTokenizer, getTokenizer } from './rag/tokenizer.js'

// 文档切分器
export { RecursiveCharacterChunker } from './rag/chunker.js'
export type { ChunkOptions } from './rag/chunker.js'

// 文件存储
export { FileStore, parseFrontmatter, serializeFrontmatter } from './storage/file-store.js'

// 向量存储
export { LibsqlVectorStore } from './storage/libsql-vector-store.js'
export { MemoryVectorStore } from './storage/memory-vector-store.js'

// BM25 倒排索引
export { BM25Index } from './rag/bm25.js'
export type { BM25SearchOptions, BM25SearchResult } from './rag/bm25.js'

// Embedding
export { NoopEmbedding } from './rag/embedding/noop-embedding.js'
export { ProviderEmbedding } from './rag/embedding/provider-embedding.js'
export type { ProviderEmbeddingOptions } from './rag/embedding/provider-embedding.js'

// Indexer
export { Indexer } from './rag/indexer.js'
export type { IndexBuildResult } from './rag/indexer.js'

// Retriever
export { Retriever } from './rag/retriever.js'

// Core
export { MemoryManager } from './core/memory-manager.js'
export type { MemoryManagerOptions } from './core/memory-manager.js'
export { MemoryWatcher } from './core/memory-watcher.js'
export type { MemoryFileChange, MemoryChangeCallback } from './core/memory-watcher.js'

// Tools
export { MemoryWriteTool } from './tools/memory-write-tool.js'
export { MemorySearchTool } from './tools/memory-search-tool.js'
export { MemoryDeleteTool } from './tools/memory-delete-tool.js'

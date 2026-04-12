// src/memory/types.ts

/**
 * 记忆系统核心类型定义。
 *
 * 设计文档：docs/plans/20260401140000_记忆系统与RAG抽象层设计.md §3.2
 */

import type { Message } from '@core/types.js'

// ═══════════════════════════════════════════════
// 基础类型
// ═══════════════════════════════════════════════

/** 记忆范围 */
export type MemoryScope = 'global' | 'project'

/** 记忆类型 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session-summary'

/** 记忆来源 */
export type MemorySource = 'user' | 'agent' | 'auto-summarize'

// ═══════════════════════════════════════════════
// 数据结构
// ═══════════════════════════════════════════════

/** 单条记忆条目（文件即记忆） */
export interface MemoryEntry {
  /**
   * 全局唯一 ID，格式: `${scope}:${relativePath}`
   * 例: 'project:insights/auth-middleware' / 'global:user_preferences'
   */
  id: string
  scope: MemoryScope
  title: string
  /** Markdown body（不含 frontmatter） */
  content: string
  type: MemoryType
  tags: string[]
  source: MemorySource
  /** ISO 8601 */
  created: string
  /** ISO 8601 */
  updated: string
  /** 原始文件绝对路径 */
  filePath: string
}

/** 记忆检索查询 */
export interface MemoryQuery {
  query: string
  scope?: MemoryScope | 'all'
  tags?: string[]
  type?: MemoryType
  topK?: number
  dateRange?: { from?: string; to?: string }
}

/** 检索结果 */
export interface MemorySearchResult {
  entry: MemoryEntry
  /** 0-1 相关性分数 */
  score: number
  /** 最佳匹配文本片段 */
  snippet: string
  /** 命中的具体 chunk 列表 */
  matchedChunks: MemoryChunk[]
}

/** 文档切分后的 chunk */
export interface MemoryChunk {
  /** chunk ID: {entryId}_{chunkIndex} */
  id: string
  entryId: string
  text: string
  /** 同一文件的第几个 chunk（从 0 开始） */
  chunkIndex: number
  /** 向量（embed 完成后填充） */
  embedding?: number[]
}

// ═══════════════════════════════════════════════
// YAML Frontmatter
// ═══════════════════════════════════════════════

/** 记忆文件 frontmatter 中的元数据字段 */
export interface MemoryFrontmatter {
  type: MemoryType
  created: string
  updated: string
  tags: string[]
  source: MemorySource
}

// ═══════════════════════════════════════════════
// 抽象接口 — 文件存储
// ═══════════════════════════════════════════════

/**
 * 文件存储抽象 — 管理记忆条目的 CRUD
 * 实现类：FileStore（Markdown 文件系统）
 */
export interface IFileStore {
  /** 扫描指定 scope 目录下所有记忆文件 */
  scan(basePath: string, scope: MemoryScope): Promise<MemoryEntry[]>
  /** 读取单个记忆文件 */
  read(filePath: string, scope: MemoryScope): Promise<MemoryEntry | null>
  /** 写入/创建记忆文件，返回完整条目 */
  save(entry: Omit<MemoryEntry, 'created' | 'updated'>): Promise<MemoryEntry>
  /** 更新已有记忆文件 */
  update(filePath: string, content: string, tags?: string[]): Promise<MemoryEntry>
  /** 删除记忆文件 */
  delete(filePath: string): Promise<void>
  /** 更新 MEMORY.md 索引文件 */
  updateIndex(basePath: string, entries: MemoryEntry[]): Promise<void>
  /** 在 basePath 下生成 .gitignore（幂等） */
  ensureGitignore(basePath: string): Promise<void>
}

// ═══════════════════════════════════════════════
// 抽象接口 — 向量存储
// ═══════════════════════════════════════════════

/** IVectorStore.upsert 的输入项 */
export interface VectorChunkInput {
  id: string
  entryId: string
  embedding: number[]
  text: string
  chunkIndex: number
  scope: MemoryScope
  projectSlug?: string
  tags: string[]
  type: MemoryType
  source: string
  created: string
  updated: string
}

/** IVectorStore.similaritySearch 的返回项 */
export interface VectorSearchHit {
  chunkId: string
  entryId: string
  text: string
  /** 0-1 相似度分数 */
  score: number
}

/** IVectorStore.similaritySearch 的查询选项 */
export interface VectorSearchOptions {
  topK: number
  scope?: MemoryScope | 'all'
  projectSlug?: string
  tags?: string[]
  type?: MemoryType
}

/**
 * 向量存储抽象 — 管理向量索引的 CRUD + 相似度检索
 *
 * 设计意图：将向量存储的具体实现（libsql 内置向量）与业务逻辑解耦。
 * 后续可替换为 FAISS、ChromaDB、Qdrant 等实现，无需改动 Retriever 和 Indexer。
 */
export interface IVectorStore {
  /** 向量维度，由 Embedding Provider 决定 */
  readonly dimension: number

  /** 初始化存储（建表/建索引） */
  initialize(): Promise<void>

  /** 清空向量表并重建（rebuild 时调用，解决 shadow index 损坏） */
  purge(): Promise<void>

  /** 批量写入向量 */
  upsert(chunks: VectorChunkInput[]): Promise<void>

  /** 删除某个记忆条目的所有 chunk */
  deleteByEntryId(entryId: string): Promise<void>

  /** 向量相似度检索，返回 Top-K 结果（按相似度降序） */
  similaritySearch(queryEmbedding: number[], options: VectorSearchOptions): Promise<VectorSearchHit[]>

  /** 获取所有 chunk 文本（BM25 索引构建用） */
  getChunkTexts(scope?: MemoryScope): Promise<Array<{ chunkId: string; text: string; entryId: string }>>

  /** 清空所有向量数据 */
  clear(): Promise<void>

  /** 关闭连接/释放资源 */
  close(): Promise<void>
}

// ═══════════════════════════════════════════════
// 抽象接口 — Embedding
// ═══════════════════════════════════════════════

/**
 * EmbeddingProvider — 独立于 LLMProvider 的 Embedding 接口。
 *
 * 不扩展 LLMProvider（后者只有 chat/countTokens），而是独立体系。
 * 仅复用 providers 配置中的 apiKey + baseURL，通过 fetch 直接调 /embeddings 端点。
 */
export interface EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  readonly maxBatchSize: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  isAvailable(): Promise<boolean>
}

// ═══════════════════════════════════════════════
// 抽象接口 — 分词器
// ═══════════════════════════════════════════════

/** 可插拔分词器接口 */
export interface Tokenizer {
  tokenize(text: string): string[]
}

// ═══════════════════════════════════════════════
// 抽象接口 — Compact 融合
// ═══════════════════════════════════════════════

/**
 * Compact 与记忆融合接口。
 * 注入到 ContextManager，在压缩前提取关键信息写入长期记忆。
 */
export interface ICompactBridge {
  /** 在压缩前调用，从即将被压缩的上下文中提取并保存关键信息 */
  extractAndSave(messages: Message[]): Promise<MemoryEntry[]>
  /** 在压缩后调用，返回可追加到上下文的记忆提示 */
  getCompactHint(): string
}

// ═══════════════════════════════════════════════
// 抽象接口 — MemoryManager
// ═══════════════════════════════════════════════

/**
 * 记忆系统统一入口。
 * 编排 FileStore、VectorStore、Retriever、Indexer 等子模块。
 */
export interface IMemoryManager {
  /** 初始化：扫描文件 + 加载已有索引 + 建 BM25（同步阶段） */
  initialize(): Promise<void>
  /** 后台增量 embed 新/改文件（异步阶段，不阻塞启动） */
  embedPending(): Promise<void>
  /** 重建索引：重置 → 重新扫描 → BM25 + Embedding 全量构建 */
  rebuild(): Promise<void>
  /** 语义检索 */
  search(query: MemoryQuery): Promise<MemorySearchResult[]>
  /** 写入记忆 */
  write(entry: Omit<MemoryEntry, 'id' | 'created' | 'updated'>): Promise<MemoryEntry>
  /** 更新记忆 */
  update(id: string, content: string, tags?: string[]): Promise<MemoryEntry>
  /** 删除记忆 */
  delete(id: string): Promise<void>
  /** 列出所有记忆（按 updated 降序） */
  list(scope?: MemoryScope | 'all'): Promise<MemoryEntry[]>
  /** 获取冷启动记忆上下文（System Prompt 注入用） */
  getRelevantContext(cwd: string): Promise<string>
}

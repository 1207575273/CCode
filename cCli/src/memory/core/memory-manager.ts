// src/memory/core/memory-manager.ts

/**
 * MemoryManager — 记忆系统统一编排入口。
 *
 * 设计文档：§3.2 IMemoryManager、§4.2-4.3 Bootstrap 集成、§5.1-5.3 离线/在线 RAG
 *
 * 职责：
 * - 编排 FileStore、Indexer、Retriever、BM25
 * - initialize() 分同步/异步两阶段（外部 IO 不上热路径）
 * - 冷启动 System Prompt 上下文注入（token 预算控制）
 * - write/search/update/delete/list 全生命周期
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import type {
  IMemoryManager,
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  MemoryScope,
  MemoryType,
  MemorySource,
  EmbeddingProvider,
  IVectorStore,
} from '@memory/types.js'
import { FileStore } from '@memory/storage/file-store.js'
import { BM25Index } from '@memory/rag/bm25.js'
import { Indexer } from '@memory/rag/indexer.js'
import { Retriever } from '@memory/rag/retriever.js'
import { getTokenizer } from '@memory/rag/tokenizer.js'
import { toProjectSlug } from '@persistence/session-utils.js'

/** 冷启动 System Prompt 记忆上下文的 token 预算（字符数，约 1500 tokens） */
const MEMORY_CONTEXT_BUDGET_CHARS = 3000

/** MemoryManager 构造参数 */
export interface MemoryManagerOptions {
  /** 项目工作目录（用于定位项目级记忆） */
  cwd: string
  /** Embedding Provider（NoopEmbedding 表示纯 BM25 模式） */
  embedding: EmbeddingProvider
  /** 向量存储（null 表示纯 BM25 模式） */
  vectorStore: IVectorStore | null
}

export class MemoryManager implements IMemoryManager {
  private readonly cwd: string
  private readonly globalMemoryDir: string
  private readonly projectMemoryDir: string
  private readonly projectSlug: string

  private readonly fileStore: FileStore
  private bm25!: BM25Index
  private indexer!: Indexer
  private retriever!: Retriever
  private readonly embedding: EmbeddingProvider
  private readonly vectorStore: IVectorStore | null

  /** entryId → MemoryEntry 内存映射 */
  private entryMap = new Map<string, MemoryEntry>()

  /** 是否已初始化 */
  private initialized = false

  constructor(options: MemoryManagerOptions) {
    this.cwd = options.cwd
    this.embedding = options.embedding
    this.vectorStore = options.vectorStore
    this.globalMemoryDir = join(homedir(), '.ccode', 'memory')
    this.projectMemoryDir = join(options.cwd, '.ccode', 'memory')
    this.projectSlug = toProjectSlug(options.cwd)

    this.fileStore = new FileStore()
    // bm25 / indexer / retriever 在 initialize() 中创建（getTokenizer 是异步的）
    this.entryMap = new Map()
  }

  /**
   * 初始化（同步阶段）：扫描文件 + 构建 BM25 + 加载 entryMap。
   * 不做 embed，毫秒级完成，不阻塞 Bootstrap。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    // 异步加载分词器 → 创建 BM25 / Indexer / Retriever
    const tokenizer = await getTokenizer()
    this.bm25 = new BM25Index(tokenizer)
    this.indexer = new Indexer({
      embedding: this.embedding,
      vectorStore: this.vectorStore,
      bm25: this.bm25,
    })
    this.retriever = new Retriever({
      embedding: this.embedding,
      vectorStore: this.vectorStore,
      bm25: this.bm25,
      entryMap: this.entryMap,
    })

    // 确保目录存在
    mkdirSync(this.globalMemoryDir, { recursive: true })
    mkdirSync(this.projectMemoryDir, { recursive: true })

    // 项目级记忆目录生成 .gitignore
    await this.fileStore.ensureGitignore(this.projectMemoryDir)

    // 初始化向量存储（建表）
    if (this.vectorStore) {
      await this.vectorStore.initialize()
    }

    // 扫描两个 scope 的记忆文件
    const globalEntries = await this.fileStore.scan(this.globalMemoryDir, 'global')
    const projectEntries = await this.fileStore.scan(this.projectMemoryDir, 'project')
    const allEntries = [...globalEntries, ...projectEntries]

    // 构建 entryMap
    this.entryMap.clear()
    for (const entry of allEntries) {
      this.entryMap.set(entry.id, entry)
    }

    // 同步构建 BM25 索引
    this.indexer.buildBM25(allEntries)

    // 更新 Retriever 的 entryMap 引用
    this.retriever.setEntryMap(this.entryMap)
  }

  /**
   * 异步阶段：增量 embed 新/改文件。
   * 启动后后台调用，不阻塞首次对话。
   */
  async embedPending(): Promise<void> {
    const allEntries = [...this.entryMap.values()]
    if (allEntries.length === 0) return
    await this.indexer.embedAndUpsert(allEntries, this.projectSlug)
  }

  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    return this.retriever.search(query)
  }

  async write(input: Omit<MemoryEntry, 'id' | 'created' | 'updated'>): Promise<MemoryEntry> {
    // 派生文件路径
    const filePath = input.filePath || this.derivePath(input.scope, input.title, input.type)

    // 派生 ID
    const baseDir = input.scope === 'global' ? this.globalMemoryDir : this.projectMemoryDir
    const relativePath = filePath.replace(baseDir, '').replace(/\\/g, '/').replace(/^\//, '').replace(/\.md$/, '')
    const id = `${input.scope}:${relativePath}`

    const entryToSave = { ...input, id, filePath }

    // 写入文件
    const saved = await this.fileStore.save(entryToSave)

    // 更新 entryMap
    this.entryMap.set(saved.id, saved)

    // 同步更新 BM25 + 异步 embed（先写后 embed）
    const { embedPromise } = this.indexer.upsertEntry(saved, this.projectSlug)

    // 更新 MEMORY.md 索引
    const scopeEntries = [...this.entryMap.values()].filter(e => e.scope === saved.scope)
    const scopeDir = saved.scope === 'global' ? this.globalMemoryDir : this.projectMemoryDir
    await this.fileStore.updateIndex(scopeDir, scopeEntries)

    // embed 后台跑，不等
    embedPromise.catch(() => { /* embed 失败不影响写入 */ })

    return saved
  }

  async update(id: string, content: string, tags?: string[]): Promise<MemoryEntry> {
    const existing = this.entryMap.get(id)
    if (!existing) throw new Error(`记忆条目不存在: ${id}`)

    const updated = await this.fileStore.update(existing.filePath, content, tags)

    // 更新 entryMap
    this.entryMap.set(id, updated)

    // 重建索引
    const { embedPromise } = this.indexer.upsertEntry(updated, this.projectSlug)
    embedPromise.catch(() => {})

    // 更新 MEMORY.md
    const scopeEntries = [...this.entryMap.values()].filter(e => e.scope === updated.scope)
    const scopeDir = updated.scope === 'global' ? this.globalMemoryDir : this.projectMemoryDir
    await this.fileStore.updateIndex(scopeDir, scopeEntries)

    return updated
  }

  async delete(id: string): Promise<void> {
    const existing = this.entryMap.get(id)
    if (!existing) return

    // 删除文件
    await this.fileStore.delete(existing.filePath)

    // 删除索引
    await this.indexer.removeEntry(id)

    // 移出 entryMap
    this.entryMap.delete(id)

    // 更新 MEMORY.md
    const scopeEntries = [...this.entryMap.values()].filter(e => e.scope === existing.scope)
    const scopeDir = existing.scope === 'global' ? this.globalMemoryDir : this.projectMemoryDir
    await this.fileStore.updateIndex(scopeDir, scopeEntries)
  }

  async list(scope?: MemoryScope | 'all'): Promise<MemoryEntry[]> {
    const entries = [...this.entryMap.values()]
    const filtered = (!scope || scope === 'all')
      ? entries
      : entries.filter(e => e.scope === scope)

    // 按 updated 降序
    return filtered.sort((a, b) => b.updated.localeCompare(a.updated))
  }

  /**
   * 获取冷启动记忆上下文（System Prompt 注入用）。
   *
   * 不走向量检索（启动时没有用户查询），按 updated 降序取最近条目。
   * token 预算 3000 字符（约 1500 tokens）。
   */
  async getRelevantContext(_cwd: string): Promise<string> {
    const entries = await this.list('all')
    if (entries.length === 0) return ''

    const top = entries.slice(0, 10)
    let totalChars = 0
    const budgeted: MemoryEntry[] = []

    for (const e of top) {
      const line = `- **${e.title}** (${e.scope}, ${e.type}) — ${e.content.slice(0, 100)}`
      if (totalChars + line.length > MEMORY_CONTEXT_BUDGET_CHARS) break
      budgeted.push(e)
      totalChars += line.length
    }

    if (budgeted.length === 0) return ''

    return `<memory-context>
以下是记忆系统中的近期记录（按更新时间排序）：
${budgeted.map(e => `- **${e.title}** (${e.scope}, ${e.type}) — ${e.content.slice(0, 100)}...`).join('\n')}

可通过 memory_search 工具按语义检索更多记忆。
可通过 memory_write 工具保存重要信息。
</memory-context>`
  }

  /**
   * 路径派生：scope + title + type → 文件系统路径。
   * 设计文档：§4.1 derivePath
   */
  private derivePath(scope: MemoryScope, title: string, type: MemoryType): string {
    const baseDir = scope === 'global' ? this.globalMemoryDir : this.projectMemoryDir

    // type → 子目录
    const subDir = type === 'user' ? ''
      : type === 'feedback' ? 'feedback'
      : type === 'session-summary' ? 'sessions'
      : 'insights'

    // title → 文件名 slug
    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      || 'untitled'

    return join(baseDir, subDir, `${slug}.md`)
  }
}

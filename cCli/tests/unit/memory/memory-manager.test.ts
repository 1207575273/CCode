import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryManager } from '@memory/core/memory-manager.js'
import { MemoryVectorStore } from '@memory/storage/memory-vector-store.js'
import { NoopEmbedding } from '@memory/rag/embedding/noop-embedding.js'
import type { EmbeddingProvider, MemoryType, MemorySource } from '@memory/types.js'

// ═══════════════════════════════════════════════
// Mock Embedding
// ═══════════════════════════════════════════════

const DIM = 8

class MockEmbedding implements EmbeddingProvider {
  readonly name = 'mock'
  readonly dimension = DIM
  readonly maxBatchSize = 20

  async embed(text: string): Promise<number[]> {
    return this.vec(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.vec(t))
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  private vec(text: string): number[] {
    const v = new Array(DIM).fill(0) as number[]
    for (let i = 0; i < text.length; i++) v[i % DIM]! += text.charCodeAt(i)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return v.map(x => x / (norm || 1))
  }
}

// ═══════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════

describe('MemoryManager', () => {
  // 用临时目录模拟项目 cwd，避免污染真实环境
  const testDir = join(tmpdir(), `ccode-mm-test-${Date.now()}`)
  let manager: MemoryManager

  /**
   * 注意：MemoryManager 内部用 homedir() 定位全局记忆。
   * 测试中我们只验证 project scope 的行为，避免污染用户全局目录。
   */
  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    const vectorStore = new MemoryVectorStore(DIM)
    manager = new MemoryManager({
      cwd: testDir,
      embedding: new MockEmbedding(),
      vectorStore,
    })
    await manager.initialize()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('initialize 创建 .ccode/memory 目录 + .gitignore', () => {
    const memoryDir = join(testDir, '.ccode', 'memory')
    expect(existsSync(memoryDir)).toBe(true)
    expect(existsSync(join(memoryDir, '.gitignore'))).toBe(true)
  })

  it('write 创建记忆文件 + BM25 立即可搜', async () => {
    const entry = await manager.write({
      scope: 'project',
      title: '认证中间件重写',
      content: '重写 auth middleware 以满足合规要求',
      type: 'project' as MemoryType,
      tags: ['auth', 'compliance'],
      source: 'agent' as MemorySource,
      filePath: '',
    })

    // 文件已创建
    expect(existsSync(entry.filePath)).toBe(true)
    expect(entry.id).toContain('project:')

    // BM25 立即可搜
    const results = await manager.search({ query: '认证中间件', topK: 3 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.entry.title).toBe('认证中间件重写')
  })

  it('write 自动生成 MEMORY.md', async () => {
    await manager.write({
      scope: 'project',
      title: '测试条目',
      content: '测试内容',
      type: 'project' as MemoryType,
      tags: [],
      source: 'user' as MemorySource,
      filePath: '',
    })

    const indexPath = join(testDir, '.ccode', 'memory', 'MEMORY.md')
    expect(existsSync(indexPath)).toBe(true)
    const content = readFileSync(indexPath, 'utf-8')
    expect(content).toContain('测试条目')
  })

  it('write → search → delete 全生命周期', async () => {
    // 写入
    const entry = await manager.write({
      scope: 'project',
      title: 'React 组件规范',
      content: '函数组件 + Hooks，不用 class 组件',
      type: 'feedback' as MemoryType,
      tags: ['frontend', 'react'],
      source: 'user' as MemorySource,
      filePath: '',
    })

    // 搜索
    let results = await manager.search({ query: 'React 组件', topK: 3 })
    expect(results.length).toBe(1)

    // 删除
    await manager.delete(entry.id)
    results = await manager.search({ query: 'React 组件', topK: 3 })
    expect(results.length).toBe(0)
    expect(existsSync(entry.filePath)).toBe(false)
  })

  it('list 按 updated 降序', async () => {
    await manager.write({
      scope: 'project', title: '条目A', content: '内容A', type: 'project' as MemoryType,
      tags: [], source: 'agent' as MemorySource, filePath: '',
    })
    // 稍等确保时间戳不同
    await new Promise(r => setTimeout(r, 10))
    await manager.write({
      scope: 'project', title: '条目B', content: '内容B', type: 'project' as MemoryType,
      tags: [], source: 'agent' as MemorySource, filePath: '',
    })

    const list = await manager.list('project')
    expect(list.length).toBe(2)
    // B 后写入，应该排第一
    expect(list[0]!.title).toBe('条目B')
  })

  it('list scope 过滤', async () => {
    await manager.write({
      scope: 'project', title: '项目条目', content: '内容', type: 'project' as MemoryType,
      tags: [], source: 'agent' as MemorySource, filePath: '',
    })

    const projectList = await manager.list('project')
    expect(projectList.length).toBe(1)

    // 注意：全局记忆写入真实 homedir，这里不测
  })

  it('getRelevantContext 冷启动上下文', async () => {
    await manager.write({
      scope: 'project', title: '测试记忆', content: '这是冷启动测试内容',
      type: 'project' as MemoryType, tags: ['test'], source: 'agent' as MemorySource, filePath: '',
    })

    const context = await manager.getRelevantContext(testDir)
    expect(context).toContain('<memory-context>')
    expect(context).toContain('测试记忆')
    expect(context).toContain('memory_search')
  })

  it('getRelevantContext 空记忆返回空', async () => {
    const context = await manager.getRelevantContext(testDir)
    expect(context).toBe('')
  })

  it('type → 子目录映射', async () => {
    const feedback = await manager.write({
      scope: 'project', title: '测试反馈', content: '内容', type: 'feedback' as MemoryType,
      tags: [], source: 'user' as MemorySource, filePath: '',
    })
    expect(feedback.filePath).toContain('feedback')

    const insight = await manager.write({
      scope: 'project', title: '架构决策', content: '内容', type: 'project' as MemoryType,
      tags: [], source: 'agent' as MemorySource, filePath: '',
    })
    expect(insight.filePath).toContain('insights')
  })

  describe('纯 BM25 降级模式', () => {
    let bm25Manager: MemoryManager

    beforeEach(async () => {
      const bm25Dir = join(testDir, 'bm25-only')
      mkdirSync(bm25Dir, { recursive: true })
      bm25Manager = new MemoryManager({
        cwd: bm25Dir,
        embedding: new NoopEmbedding(),
        vectorStore: null,
      })
      await bm25Manager.initialize()
    })

    it('纯 BM25 模式下 write + search 正常工作', async () => {
      await bm25Manager.write({
        scope: 'project', title: '纯BM25测试', content: '数据库索引优化',
        type: 'project' as MemoryType, tags: [], source: 'agent' as MemorySource, filePath: '',
      })

      const results = await bm25Manager.search({ query: '数据库索引', topK: 3 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.entry.title).toBe('纯BM25测试')
    })
  })
})

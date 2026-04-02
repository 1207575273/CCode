// tests/integration/memory-e2e.test.ts

/**
 * 记忆系统端到端语义检索质量验证。
 *
 * 需要真实 Embedding API（GLM embedding-3）。
 * 跳过条件：无 config.json 或 memory.enabled=false 或 API 不可达。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MemoryManager } from '@memory/core/memory-manager.js'
import { ProviderEmbedding } from '@memory/rag/embedding/provider-embedding.js'
import { LibsqlVectorStore } from '@memory/storage/libsql-vector-store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// 读取配置
function loadConfig(): { apiKey: string; baseURL: string; model: string; dimension: number } | null {
  const configPath = join(homedir(), '.ccode', 'config.json')
  if (!existsSync(configPath)) return null
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const memConfig = config.memory
    if (!memConfig?.enabled || !memConfig?.embedding?.provider || !memConfig?.embedding?.model) return null
    const provConfig = config.providers?.[memConfig.embedding.provider]
    if (!provConfig?.apiKey) return null
    return {
      apiKey: provConfig.apiKey,
      baseURL: memConfig.embedding.baseURL ?? provConfig.baseURL,
      model: memConfig.embedding.model,
      dimension: memConfig.embedding.dimension ?? 1024,
    }
  } catch { return null }
}

const embConfig = loadConfig()
const SKIP = !embConfig

describe.skipIf(SKIP)('Memory E2E — 真实 Embedding 语义检索', () => {
  let mm: MemoryManager
  let tempDir: string
  let vectorStore: LibsqlVectorStore

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-e2e-'))

    const embedding = new ProviderEmbedding({
      providerName: 'glm',
      apiKey: embConfig!.apiKey,
      baseURL: embConfig!.baseURL,
      model: embConfig!.model,
      dimension: embConfig!.dimension,
    })

    // 验证连通性
    const available = await embedding.isAvailable()
    if (!available) throw new Error('Embedding API 不可达')

    vectorStore = new LibsqlVectorStore(embConfig!.dimension)
    await vectorStore.initialize()

    mm = new MemoryManager({
      cwd: tempDir,
      embedding,
      vectorStore,
    })

    await mm.initialize()
  }, 30000)

  afterAll(async () => {
    // 清理向量数据
    await vectorStore?.clear()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('写入 3 条记忆 + 语义搜索命中正确', async () => {
    // 写入 3 条不同主题的记忆
    await mm.write({
      scope: 'project', title: '认证中间件重构', type: 'project', tags: ['auth'],
      content: '重写 auth middleware 是因为 legal 标记了 session token 存储不满足合规要求。范围决策应优先合规而非易用性。',
      source: 'user', filePath: '',
    })

    await mm.write({
      scope: 'project', title: '数据库性能优化', type: 'project', tags: ['db', 'perf'],
      content: '用户量超过 10 万后，订单查询接口 P99 从 200ms 飙升到 3s。根因是 orders 表缺少 user_id + created_at 的联合索引。',
      source: 'user', filePath: '',
    })

    await mm.write({
      scope: 'project', title: '前端组件规范', type: 'feedback', tags: ['react', 'frontend'],
      content: '用户偏好函数组件 + Hooks，不使用 class 组件。自定义 Hook 命名 useXxx。列表渲染必须提供稳定唯一 key。',
      source: 'user', filePath: '',
    })

    // 等 embedding 异步完成
    await new Promise(r => setTimeout(r, 3000))

    // 语义搜索：用自然语言查询，不是关键词精确匹配
    const results = await mm.search({ query: '安全合规问题', topK: 3 })

    console.log('\n=== 搜索"安全合规问题" ===')
    for (const r of results) {
      console.log(`  ${r.score.toFixed(3)} | ${r.entry.title} | ${r.snippet.slice(0, 50)}...`)
    }

    // 认证中间件那条应该排第一（语义最相关）
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.entry.title).toBe('认证中间件重构')
  }, 30000)

  it('语义检索优于关键词匹配', async () => {
    // "查询慢了怎么办" 不包含 "P99" "索引" 等关键词，但语义相关
    const results = await mm.search({ query: '查询慢了怎么办', topK: 3 })

    console.log('\n=== 搜索"查询慢了怎么办" ===')
    for (const r of results) {
      console.log(`  ${r.score.toFixed(3)} | ${r.entry.title} | ${r.snippet.slice(0, 50)}...`)
    }

    // 数据库性能优化应该排在前面
    const dbResult = results.find(r => r.entry.title === '数据库性能优化')
    expect(dbResult).toBeDefined()
    expect(dbResult!.score).toBeGreaterThan(0.3)
  }, 15000)

  it('tags 过滤有效', async () => {
    const results = await mm.search({ query: '组件开发', topK: 3, tags: ['react'] })

    console.log('\n=== 搜索"组件开发" tags=[react] ===')
    for (const r of results) {
      console.log(`  ${r.score.toFixed(3)} | ${r.entry.title} | tags: ${r.entry.tags.join(',')}`)
    }

    // 只返回带 react 标签的
    expect(results.every(r => r.entry.tags.includes('react'))).toBe(true)
  }, 15000)

  it('不相关查询返回低分或空', async () => {
    const results = await mm.search({ query: '如何做蛋糕', topK: 3 })

    console.log('\n=== 搜索"如何做蛋糕" ===')
    for (const r of results) {
      console.log(`  ${r.score.toFixed(3)} | ${r.entry.title}`)
    }

    // 所有结果的分数应该很低（或无结果）
    if (results.length > 0) {
      expect(results[0]!.score).toBeLessThan(0.5)
    }
  }, 15000)
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryManager } from '@memory/core/memory-manager.js'
import { MemoryWriteTool } from '@memory/tools/memory-write-tool.js'
import { MemorySearchTool } from '@memory/tools/memory-search-tool.js'
import { MemoryVectorStore } from '@memory/storage/memory-vector-store.js'
import { NoopEmbedding } from '@memory/rag/embedding/noop-embedding.js'
import type { ToolContext } from '@tools/core/types.js'

const testDir = join(tmpdir(), `ccode-tools-test-${Date.now()}`)
const ctx: ToolContext = { cwd: testDir }

describe('MemoryWriteTool', () => {
  let tool: MemoryWriteTool
  let manager: MemoryManager

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    manager = new MemoryManager({
      cwd: testDir,
      embedding: new NoopEmbedding(),
      vectorStore: null,
    })
    await manager.initialize()
    tool = new MemoryWriteTool(manager)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('正常写入返回成功', async () => {
    const result = await tool.execute({
      title: '测试记忆',
      content: '这是测试内容',
      type: 'project',
      tags: ['test'],
      scope: 'project',
    }, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toContain('测试记忆')
    expect(result.output).toContain('project')
  })

  it('空标题返回错误', async () => {
    const result = await tool.execute({
      title: '',
      content: '内容',
      type: 'project',
    }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('标题')
  })

  it('空内容返回错误', async () => {
    const result = await tool.execute({
      title: '标题',
      content: '',
      type: 'project',
    }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('内容')
  })

  it('无效 type 返回错误', async () => {
    const result = await tool.execute({
      title: '标题',
      content: '内容',
      type: 'invalid_type',
    }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('无效')
  })

  it('默认 scope 为 project', async () => {
    const result = await tool.execute({
      title: '默认scope测试',
      content: '内容',
      type: 'project',
    }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('project')
  })
})

describe('MemorySearchTool', () => {
  let writeTool: MemoryWriteTool
  let searchTool: MemorySearchTool
  let manager: MemoryManager

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    manager = new MemoryManager({
      cwd: testDir,
      embedding: new NoopEmbedding(),
      vectorStore: null,
    })
    await manager.initialize()
    writeTool = new MemoryWriteTool(manager)
    searchTool = new MemorySearchTool(manager)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('搜索到结果', async () => {
    await writeTool.execute({
      title: '认证中间件设计',
      content: '认证中间件需要重写以满足合规要求',
      type: 'project',
      tags: ['auth'],
    }, ctx)

    const result = await searchTool.execute({ query: '认证中间件' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('认证中间件设计')
    expect(result.output).toContain('score')
  })

  it('无匹配返回提示', async () => {
    const result = await searchTool.execute({ query: '量子物理' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('未找到')
  })

  it('空查询返回错误', async () => {
    const result = await searchTool.execute({ query: '' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('查询')
  })

  it('write → search → delete → search 端到端', async () => {
    // 写入
    await writeTool.execute({
      title: 'React组件规范',
      content: '函数组件 Hooks 风格',
      type: 'feedback',
      tags: ['frontend'],
    }, ctx)

    // 搜索到
    let result = await searchTool.execute({ query: 'React组件' }, ctx)
    expect(result.output).toContain('React组件规范')

    // 删除
    const entries = await manager.list('project')
    const reactEntry = entries.find(e => e.title === 'React组件规范')
    expect(reactEntry).toBeDefined()
    await manager.delete(reactEntry!.id)

    // 搜索不到
    result = await searchTool.execute({ query: 'React组件' }, ctx)
    expect(result.output).toContain('未找到')
  })
})

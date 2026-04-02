import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileStore, parseFrontmatter, serializeFrontmatter } from '@memory/storage/file-store.js'
import type { MemoryFrontmatter, MemorySource, MemoryType } from '@memory/types.js'

// ═══════════════════════════════════════════════
// Frontmatter 解析/序列化
// ═══════════════════════════════════════════════

describe('parseFrontmatter', () => {
  it('解析完整 frontmatter', () => {
    const raw = `---
type: project
created: 2026-04-01T10:00:00Z
updated: 2026-04-02T10:00:00Z
tags: [auth, middleware]
source: agent
---

# 标题

正文内容`
    const { meta, body } = parseFrontmatter(raw)
    expect(meta['type']).toBe('project')
    expect(meta['created']).toBe('2026-04-01T10:00:00Z')
    expect(meta['tags']).toEqual(['auth', 'middleware'])
    expect(meta['source']).toBe('agent')
    expect(body).toContain('# 标题')
    expect(body).toContain('正文内容')
  })

  it('空 tags 数组', () => {
    const raw = `---
type: user
tags: []
source: user
---

内容`
    const { meta } = parseFrontmatter(raw)
    expect(meta['tags']).toEqual([])
  })

  it('无 frontmatter 返回原始内容', () => {
    const raw = '# 纯 Markdown\n\n内容'
    const { meta, body } = parseFrontmatter(raw)
    expect(Object.keys(meta)).toHaveLength(0)
    expect(body).toBe(raw)
  })

  it('不完整 frontmatter（缺少结束分隔符）', () => {
    const raw = '---\ntype: user\n没有结束分隔符\n内容'
    const { meta, body } = parseFrontmatter(raw)
    expect(Object.keys(meta)).toHaveLength(0)
    expect(body).toBe(raw)
  })
})

describe('serializeFrontmatter', () => {
  it('序列化完整 frontmatter', () => {
    const meta: MemoryFrontmatter = {
      type: 'feedback',
      created: '2026-04-01T10:00:00Z',
      updated: '2026-04-01T10:00:00Z',
      tags: ['testing', 'approach'],
      source: 'user',
    }
    const result = serializeFrontmatter(meta)
    expect(result).toContain('---')
    expect(result).toContain('type: feedback')
    expect(result).toContain('tags: [testing, approach]')
  })
})

// ═══════════════════════════════════════════════
// FileStore CRUD
// ═══════════════════════════════════════════════

describe('FileStore', () => {
  const testDir = join(tmpdir(), `ccode-memory-test-${Date.now()}`)
  const store = new FileStore()

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('save 创建文件并返回完整 entry', async () => {
    const entry = await store.save({
      id: 'project:insights/test-entry',
      scope: 'project',
      title: '测试记忆',
      content: '这是测试内容',
      type: 'project' as MemoryType,
      tags: ['test'],
      source: 'agent' as MemorySource,
      filePath: join(testDir, 'insights', 'test-entry.md'),
    })

    expect(entry.created).toBeTruthy()
    expect(entry.updated).toBeTruthy()
    expect(existsSync(entry.filePath)).toBe(true)

    // 验证文件内容包含 frontmatter
    const content = readFileSync(entry.filePath, 'utf-8')
    expect(content).toContain('---')
    expect(content).toContain('type: project')
    expect(content).toContain('tags: [test]')
    expect(content).toContain('# 测试记忆')
  })

  it('scan 扫描目录下所有记忆文件', async () => {
    // 创建两个测试文件
    await store.save({
      id: 'project:entry-a',
      scope: 'project',
      title: '条目A',
      content: '内容A',
      type: 'project' as MemoryType,
      tags: ['a'],
      source: 'user' as MemorySource,
      filePath: join(testDir, 'entry-a.md'),
    })
    await store.save({
      id: 'project:sub/entry-b',
      scope: 'project',
      title: '条目B',
      content: '内容B',
      type: 'feedback' as MemoryType,
      tags: ['b'],
      source: 'agent' as MemorySource,
      filePath: join(testDir, 'sub', 'entry-b.md'),
    })

    const entries = await store.scan(testDir, 'project')
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.title)).toContain('条目A')
    expect(entries.map(e => e.title)).toContain('条目B')
  })

  it('scan 排除 MEMORY.md', async () => {
    writeFileSync(join(testDir, 'MEMORY.md'), '# Index\n', 'utf-8')
    await store.save({
      id: 'project:real-entry',
      scope: 'project',
      title: '真实条目',
      content: '内容',
      type: 'project' as MemoryType,
      tags: [],
      source: 'user' as MemorySource,
      filePath: join(testDir, 'real-entry.md'),
    })

    const entries = await store.scan(testDir, 'project')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('真实条目')
  })

  it('delete 删除文件', async () => {
    const entry = await store.save({
      id: 'project:to-delete',
      scope: 'project',
      title: '待删除',
      content: '内容',
      type: 'project' as MemoryType,
      tags: [],
      source: 'user' as MemorySource,
      filePath: join(testDir, 'to-delete.md'),
    })

    expect(existsSync(entry.filePath)).toBe(true)
    await store.delete(entry.filePath)
    expect(existsSync(entry.filePath)).toBe(false)
  })

  it('updateIndex 生成 MEMORY.md', async () => {
    const entries = [
      { id: 'project:a', scope: 'project' as const, title: '条目A', content: '内容A摘要', type: 'project' as MemoryType, tags: [], source: 'user' as MemorySource, created: '', updated: '', filePath: join(testDir, 'a.md') },
      { id: 'project:sub/b', scope: 'project' as const, title: '条目B', content: '内容B摘要', type: 'feedback' as MemoryType, tags: [], source: 'agent' as MemorySource, created: '', updated: '', filePath: join(testDir, 'sub', 'b.md') },
    ]
    await store.updateIndex(testDir, entries)

    const indexContent = readFileSync(join(testDir, 'MEMORY.md'), 'utf-8')
    expect(indexContent).toContain('# Memory Index')
    expect(indexContent).toContain('[条目A](a.md)')
    expect(indexContent).toContain('[条目B](sub/b.md)')
  })

  it('ensureGitignore 生成 .gitignore（幂等）', async () => {
    await store.ensureGitignore(testDir)
    const content = readFileSync(join(testDir, '.gitignore'), 'utf-8')
    expect(content).toContain('*')
    expect(content).toContain('!MEMORY.md')

    // 第二次调用不应覆盖
    await store.ensureGitignore(testDir)
    const content2 = readFileSync(join(testDir, '.gitignore'), 'utf-8')
    expect(content2).toBe(content)
  })

  it('scan 空目录返回空数组', async () => {
    const emptyDir = join(testDir, 'empty')
    mkdirSync(emptyDir, { recursive: true })
    const entries = await store.scan(emptyDir, 'project')
    expect(entries).toEqual([])
  })

  it('scan 不存在的目录返回空数组', async () => {
    const entries = await store.scan(join(testDir, 'nonexistent'), 'project')
    expect(entries).toEqual([])
  })
})

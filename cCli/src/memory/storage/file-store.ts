// src/memory/storage/file-store.ts

/**
 * FileStore — 基于 Markdown 文件系统的记忆存储。
 *
 * 设计文档：§2.1-2.4、§3.3
 *
 * 职责：
 * - 记忆文件 CRUD（YAML frontmatter + Markdown body）
 * - MEMORY.md 索引自动维护
 * - .gitignore 自动生成（项目级记忆不被 git 跟踪）
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, basename, extname } from 'node:path'
import type { IFileStore, MemoryEntry, MemoryScope, MemoryFrontmatter, MemoryType, MemorySource } from '@memory/types.js'

// ═══════════════════════════════════════════════
// YAML Frontmatter 解析/序列化
// ═══════════════════════════════════════════════

/**
 * 轻量 YAML frontmatter 解析器（不引入 gray-matter 依赖）。
 *
 * 支持的值类型：
 * - 字符串（含 ISO 日期）
 * - 数组 `[a, b, c]`
 * - 裸字符串（无引号）
 */
export function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('---')) {
    return { meta: {}, body: raw }
  }

  const secondDash = trimmed.indexOf('\n---', 3)
  if (secondDash === -1) {
    return { meta: {}, body: raw }
  }

  const yamlBlock = trimmed.slice(4, secondDash).trim() // 跳过首行 '---\n'
  const body = trimmed.slice(secondDash + 4).trim() // 跳过 '\n---\n'

  const meta: Record<string, unknown> = {}
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (!key) continue
    meta[key] = parseYamlValue(value)
  }

  return { meta, body }
}

/** 解析简单 YAML 值 */
function parseYamlValue(value: string): unknown {
  // 数组: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1)
    if (inner.trim().length === 0) return []
    return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
  }
  // 去掉引号
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/** 序列化 frontmatter 为 YAML 字符串 */
export function serializeFrontmatter(meta: MemoryFrontmatter): string {
  const lines = [
    '---',
    `type: ${meta.type}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `tags: [${meta.tags.join(', ')}]`,
    `source: ${meta.source}`,
    '---',
  ]
  return lines.join('\n')
}

// ═══════════════════════════════════════════════
// FileStore 实现
// ═══════════════════════════════════════════════

export class FileStore implements IFileStore {

  /**
   * 扫描指定目录下所有 .md 文件（排除 MEMORY.md），解析为 MemoryEntry。
   */
  async scan(basePath: string, scope: MemoryScope): Promise<MemoryEntry[]> {
    if (!existsSync(basePath)) return []

    const entries: MemoryEntry[] = []
    this.walkDir(basePath, basePath, scope, entries)

    // 按 updated 降序排序
    entries.sort((a, b) => b.updated.localeCompare(a.updated))
    return entries
  }

  /** 递归遍历目录 */
  private walkDir(dir: string, basePath: string, scope: MemoryScope, entries: MemoryEntry[]): void {
    let items: string[]
    try {
      items = readdirSync(dir)
    } catch {
      return
    }

    for (const item of items) {
      const fullPath = join(dir, item)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        this.walkDir(fullPath, basePath, scope, entries)
      } else if (item.endsWith('.md') && item !== 'MEMORY.md') {
        const entry = this.parseFile(fullPath, basePath, scope)
        if (entry) entries.push(entry)
      }
    }
  }

  /** 解析单个 .md 文件为 MemoryEntry */
  private parseFile(filePath: string, basePath: string, scope: MemoryScope): MemoryEntry | null {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const { meta, body } = parseFrontmatter(raw)

      const relativePath = relative(basePath, filePath)
        .replace(/\\/g, '/')
        .replace(/\.md$/, '')

      const id = `${scope}:${relativePath}`
      const now = new Date().toISOString()

      // 从 body 中提取标题（第一个 # 行）
      const titleMatch = body.match(/^#\s+(.+)$/m)
      const title = titleMatch ? titleMatch[1]!.trim() : basename(filePath, '.md')

      return {
        id,
        scope,
        title,
        content: body,
        type: (meta['type'] as MemoryType) ?? 'project',
        tags: Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : [],
        source: (meta['source'] as MemorySource) ?? 'user',
        created: (meta['created'] as string) ?? now,
        updated: (meta['updated'] as string) ?? now,
        filePath,
      }
    } catch {
      return null
    }
  }

  async read(filePath: string, scope: MemoryScope): Promise<MemoryEntry | null> {
    if (!existsSync(filePath)) return null
    // 需要 basePath 来计算 relativePath，从 filePath 中反推
    // 向上找 memory/ 目录
    const memoryIdx = filePath.replace(/\\/g, '/').lastIndexOf('/memory/')
    if (memoryIdx === -1) return null
    const basePath = filePath.slice(0, memoryIdx + '/memory'.length + 1)
    return this.parseFile(filePath, basePath, scope)
  }

  async save(entry: Omit<MemoryEntry, 'created' | 'updated'>): Promise<MemoryEntry> {
    const now = new Date().toISOString()
    const fullEntry: MemoryEntry = {
      ...entry,
      created: now,
      updated: now,
    }

    this.writeEntryFile(fullEntry)
    return fullEntry
  }

  async update(filePath: string, content: string, tags?: string[]): Promise<MemoryEntry> {
    if (!existsSync(filePath)) {
      throw new Error(`记忆文件不存在: ${filePath}`)
    }

    const raw = readFileSync(filePath, 'utf-8')
    const { meta } = parseFrontmatter(raw)
    const now = new Date().toISOString()

    // 保留原有 frontmatter，更新 content 和 updated
    const updatedMeta: MemoryFrontmatter = {
      type: (meta['type'] as MemoryType) ?? 'project',
      created: (meta['created'] as string) ?? now,
      updated: now,
      tags: tags ?? (Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : []),
      source: (meta['source'] as MemorySource) ?? 'user',
    }

    const fileContent = serializeFrontmatter(updatedMeta) + '\n\n' + content
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, fileContent, 'utf-8')

    // 重新读取返回完整 entry
    const memoryIdx = filePath.replace(/\\/g, '/').lastIndexOf('/memory/')
    const basePath = memoryIdx !== -1 ? filePath.slice(0, memoryIdx + '/memory'.length + 1) : dirname(filePath)
    const scope = filePath.includes('.ccode/memory') && !filePath.includes(require('node:os').homedir())
      ? 'project' as MemoryScope
      : 'global' as MemoryScope
    const entry = this.parseFile(filePath, basePath, scope)
    if (!entry) throw new Error(`写入后无法解析文件: ${filePath}`)
    return entry
  }

  async delete(filePath: string): Promise<void> {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  }

  /**
   * 更新 MEMORY.md 索引文件。
   * 每个条目一行：`- [标题](相对路径) — 简短描述`
   */
  async updateIndex(basePath: string, entries: MemoryEntry[]): Promise<void> {
    const indexPath = join(basePath, 'MEMORY.md')
    const lines = ['# Memory Index', '']

    for (const entry of entries) {
      const relPath = relative(basePath, entry.filePath).replace(/\\/g, '/')
      const desc = entry.content.slice(0, 80).replace(/\n/g, ' ').trim()
      lines.push(`- [${entry.title}](${relPath}) — ${desc}`)
    }

    lines.push('') // 末尾空行
    mkdirSync(basePath, { recursive: true })
    writeFileSync(indexPath, lines.join('\n'), 'utf-8')
  }

  /**
   * 在 basePath 下生成 .gitignore（幂等）。
   * 忽略所有文件，保留 .gitignore 和 MEMORY.md。
   */
  async ensureGitignore(basePath: string): Promise<void> {
    const gitignorePath = join(basePath, '.gitignore')
    if (existsSync(gitignorePath)) return

    const content = [
      '# 记忆文件为个人知识，默认不跟踪',
      '*',
      '!.gitignore',
      '!MEMORY.md',
      '',
    ].join('\n')

    mkdirSync(basePath, { recursive: true })
    writeFileSync(gitignorePath, content, 'utf-8')
  }

  /** 将 MemoryEntry 写入文件 */
  private writeEntryFile(entry: MemoryEntry): void {
    const meta: MemoryFrontmatter = {
      type: entry.type,
      created: entry.created,
      updated: entry.updated,
      tags: entry.tags,
      source: entry.source,
    }

    // 确保 content 以标题开头
    const hasTitle = entry.content.trimStart().startsWith('# ')
    const body = hasTitle ? entry.content : `# ${entry.title}\n\n${entry.content}`
    const fileContent = serializeFrontmatter(meta) + '\n\n' + body

    mkdirSync(dirname(entry.filePath), { recursive: true })
    writeFileSync(entry.filePath, fileContent, 'utf-8')
  }
}

// src/file-index/file-index.ts

import fg from 'fast-glob'
import { Fzf } from 'fzf'
import type { Ignore } from 'ignore'
import { createIgnoreFilter } from './ignore-rules.js'
import type { SearchResult, DirEntry } from './types.js'

/**
 * 文件索引器
 *
 * 启动时全量扫描项目目录，维护排序后的相对路径列表。
 * 支持增量更新（添加/删除）和模糊搜索。
 */
export class FileIndex {
  /** 排序后的相对路径数组（正斜杠分隔） */
  private paths: string[] = []
  /** fzf 模糊搜索实例，paths 变化时重建 */
  private fzf: Fzf<string[]> | null = null
  /** 忽略规则过滤器 */
  private ignoreFilter: Ignore

  constructor(private cwd: string) {
    this.ignoreFilter = createIgnoreFilter(cwd)
  }

  /**
   * 全量扫描项目目录
   *
   * 使用 fast-glob 遍历所有文件，经 ignore 规则过滤后，
   * 排序存入 paths 并重建 fzf 实例。
   * 通常在启动时调用一次。
   */
  async scan(): Promise<void> {
    // fast-glob 返回正斜杠路径
    // suppressErrors: 跳过无权限的目录（如 Windows Application Data junction）
    let allFiles: string[]
    try {
      allFiles = await fg('**/*', {
        cwd: this.cwd,
        dot: false,
        onlyFiles: true,
        suppressErrors: true,
      })
    } catch {
      // 极端情况：cwd 本身无权限
      allFiles = []
    }

    // 用 ignore 实例过滤
    this.paths = this.ignoreFilter.filter(allFiles).sort()

    // 重建 fzf 实例
    this.rebuildFzf()
  }

  /**
   * 增量添加文件路径
   *
   * 检查 ignore 规则，通过则插入 paths（保持排序），并重建 fzf。
   *
   * @param relativePath - 相对路径（正斜杠分隔）
   */
  add(relativePath: string): void {
    // 被忽略的路径不加入索引
    if (this.ignoreFilter.ignores(relativePath)) {
      return
    }

    // 已存在则跳过
    const insertIdx = this.findInsertIndex(relativePath)
    if (this.paths[insertIdx] === relativePath) {
      return
    }

    // 插入并保持排序
    this.paths.splice(insertIdx, 0, relativePath)
    this.rebuildFzf()
  }

  /**
   * 增量删除文件路径
   *
   * @param relativePath - 相对路径（正斜杠分隔）
   */
  remove(relativePath: string): void {
    const idx = this.findExactIndex(relativePath)
    if (idx === -1) {
      return
    }

    this.paths.splice(idx, 1)
    this.rebuildFzf()
  }

  /**
   * 模糊搜索文件路径
   *
   * @param query - 搜索关键词
   * @param limit - 最大返回条数，默认 20
   * @returns 匹配结果数组，按分数降序
   */
  search(query: string, limit = 20): SearchResult[] {
    if (!this.fzf || query.length === 0) {
      return []
    }

    const entries = this.fzf.find(query)
    return entries.slice(0, limit).map((entry) => ({
      path: entry.item,
      score: entry.score,
      positions: entry.positions,
    }))
  }

  /**
   * 获取全部已索引的路径
   *
   * @returns 排序后的相对路径数组（只读副本）
   */
  getAll(): string[] {
    return [...this.paths]
  }

  /** 已索引的文件数量 */
  get size(): number {
    return this.paths.length
  }

  /**
   * 列出指定目录下的直接子项（文件和子目录）。
   *
   * 类似文件浏览器：
   * - listEntries("") → 根目录下的文件和文件夹
   * - listEntries("src/") → src/ 下的文件和文件夹
   *
   * 文件夹以 "/" 结尾，排在前面；文件排在后面。
   *
   * @param dirPrefix - 目录前缀（空字符串表示根目录，非空时必须以 "/" 结尾）
   * @param limit - 最大返回条数
   */
  listEntries(dirPrefix: string, limit = 30): DirEntry[] {
    const dirs = new Set<string>()
    const files: string[] = []

    for (const p of this.paths) {
      // 只看该目录下的路径
      if (!p.startsWith(dirPrefix)) continue

      const rest = p.slice(dirPrefix.length)
      const slashIdx = rest.indexOf('/')

      if (slashIdx !== -1) {
        // 有子路径 → 这是一个子目录
        dirs.add(rest.slice(0, slashIdx + 1)) // 含末尾 "/"
      } else {
        // 没有子路径 → 这是一个直接文件
        files.push(rest)
      }

      // 提前退出：收集足够多的条目
      if (dirs.size + files.length >= limit * 3) break
    }

    // 文件夹在前，文件在后
    const entries: DirEntry[] = []
    const sortedDirs = [...dirs].sort()
    for (const d of sortedDirs) {
      if (entries.length >= limit) break
      entries.push({ name: d, fullPath: dirPrefix + d, isDir: true })
    }
    for (const f of files) {
      if (entries.length >= limit) break
      entries.push({ name: f, fullPath: dirPrefix + f, isDir: false })
    }

    return entries
  }

  /**
   * 获取当前使用的忽略规则过滤器
   *
   * 供 FileWatcher 等外部模块复用，避免重复创建。
   */
  getIgnoreFilter(): Ignore {
    return this.ignoreFilter
  }

  /** 重建 fzf 模糊搜索实例 */
  private rebuildFzf(): void {
    this.fzf = new Fzf(this.paths, {
      selector: (item: string) => item,
      limit: 50,
    })
  }

  /**
   * 二分查找插入位置
   * 返回值为应插入的索引，如果该位置元素与目标相同则表示已存在
   */
  private findInsertIndex(target: string): number {
    let lo = 0
    let hi = this.paths.length

    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      // paths[mid] 一定存在（mid 在 [lo, hi) 范围内）
      if (this.paths[mid]! < target) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }

    return lo
  }

  /** 二分查找精确位置，不存在返回 -1 */
  private findExactIndex(target: string): number {
    const idx = this.findInsertIndex(target)
    return this.paths[idx] === target ? idx : -1
  }
}

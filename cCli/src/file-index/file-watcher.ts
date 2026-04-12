// src/file-index/file-watcher.ts

import { watch, stat, type FSWatcher } from 'node:fs'
import type { Ignore } from 'ignore'
import type { FileIndex } from './file-index.js'
import { dbg } from '../debug.js'

/** 防抖延迟（毫秒） */
const DEBOUNCE_MS = 100

/**
 * 文件监听器
 *
 * 使用 Node.js 内置 fs.watch + recursive 模式监听项目目录变更，
 * 防抖后批量更新 FileIndex。
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingAdds: Set<string> = new Set()
  private pendingRemoves: Set<string> = new Set()

  constructor(
    private cwd: string,
    private index: FileIndex,
    private ignoreFilter: Ignore,
  ) {}

  /**
   * 启动文件监听
   *
   * 监听 cwd 下的所有文件变更（recursive 模式），
   * 收集变更事件后防抖批量更新索引。
   */
  start(): void {
    try {
      this.watcher = watch(
        this.cwd,
        { recursive: true },
        (eventType, filename) => {
          // filename 可能为 null（平台差异）
          if (!filename) {
            return
          }

          this.handleEvent(eventType, filename)
        },
      )

      // 监听错误，避免崩溃整个应用
      this.watcher.on('error', (err) => {
        dbg(`[FileWatcher] watcher 错误: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    } catch (err) {
      dbg(`[FileWatcher] 启动失败 cwd=${this.cwd}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /** 停止文件监听并清理资源 */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    this.pendingAdds.clear()
    this.pendingRemoves.clear()
  }

  /**
   * 处理单个文件变更事件
   *
   * Windows 上 filename 使用反斜杠，需统一转为正斜杠。
   * rename 事件表示新建或删除，需要 stat 判断；
   * change 事件表示内容变更，文件已在索引中，无需处理。
   */
  private handleEvent(eventType: string, filename: string): void {
    // Windows 反斜杠 → 正斜杠
    const normalizedPath = filename.replace(/\\/g, '/')

    // 忽略规则过滤
    if (this.ignoreFilter.ignores(normalizedPath)) {
      return
    }

    // change 事件只是内容变更，不影响索引
    if (eventType === 'change') {
      return
    }

    // rename 事件：需要判断是新建还是删除
    this.checkFileExists(normalizedPath)
  }

  /**
   * 检查文件是否存在，决定是添加还是删除
   *
   * 使用 fs.stat 异步判断，存在则加入 pendingAdds，
   * 不存在则加入 pendingRemoves，然后触发防抖刷新。
   */
  private checkFileExists(relativePath: string): void {
    const fullPath = `${this.cwd}/${relativePath}`

    stat(fullPath, (err, stats) => {
      try {
        if (err || !stats) {
          // 文件不存在，标记为删除
          this.pendingAdds.delete(relativePath)
          this.pendingRemoves.add(relativePath)
        } else if (stats.isFile()) {
          // 文件存在且是普通文件，标记为添加
          this.pendingRemoves.delete(relativePath)
          this.pendingAdds.add(relativePath)
        }

        this.scheduleBatchUpdate()
      } catch (err) {
        dbg(`[FileWatcher] checkFileExists 异常 path=${relativePath}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    })
  }

  /** 防抖调度批量更新 */
  private scheduleBatchUpdate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.flushPending()
    }, DEBOUNCE_MS)
  }

  /** 批量刷新待处理的添加和删除 */
  private flushPending(): void {
    try {
      // 先处理删除
      for (const path of this.pendingRemoves) {
        this.index.remove(path)
      }

      // 再处理添加
      for (const path of this.pendingAdds) {
        this.index.add(path)
      }

      this.pendingRemoves.clear()
      this.pendingAdds.clear()
    } catch (err) {
      dbg(`[FileWatcher] flushPending 异常: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

// src/memory/core/memory-watcher.ts

/**
 * MemoryWatcher — 双目录文件监听 + 增量索引触发。
 *
 * 设计文档：§4.6
 *
 * 监听全局 ~/.ccode/memory/ 和项目 .ccode/memory/ 两个目录。
 * 文件变更时触发回调，由 MemoryManager 决定增量索引逻辑。
 *
 * 复用 src/file-index/file-watcher.ts 的设计模式：
 * - fs.watch + recursive
 * - debounce 批量刷新
 * - selfWritePaths 防止自身写入触发循环
 */

import { watch, stat, existsSync, type FSWatcher } from 'node:fs'
import type { MemoryScope } from '@memory/types.js'

/** 防抖延迟（毫秒） */
const DEBOUNCE_MS = 300

/** 变更事件 */
export interface MemoryFileChange {
  /** 文件绝对路径 */
  filePath: string
  /** 变更类型 */
  type: 'add' | 'change' | 'delete'
  /** 所属 scope */
  scope: MemoryScope
}

/** 变更回调 */
export type MemoryChangeCallback = (changes: MemoryFileChange[]) => void

export class MemoryWatcher {
  private watchers: FSWatcher[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingChanges = new Map<string, MemoryFileChange>()

  /** 自身写入的路径集合，watcher 回调中跳过这些路径 */
  private selfWritePaths = new Set<string>()

  private callback: MemoryChangeCallback

  constructor(callback: MemoryChangeCallback) {
    this.callback = callback
  }

  /**
   * 标记路径为自身写入，watcher 不处理。
   * 写入完成后调用 unmarkSelfWrite 移除。
   */
  markSelfWrite(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/')
    this.selfWritePaths.add(normalized)
  }

  unmarkSelfWrite(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/')
    this.selfWritePaths.delete(normalized)
  }

  /**
   * 启动监听。
   *
   * @param dirs 要监听的目录列表 + scope 标记
   */
  start(dirs: Array<{ path: string; scope: MemoryScope }>): void {
    for (const { path: dir, scope } of dirs) {
      if (!existsSync(dir)) continue
      try {
        const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return
          const normalized = filename.replace(/\\/g, '/')
          // 只关心 .md 文件
          if (!normalized.endsWith('.md')) return
          // 跳过 MEMORY.md（索引文件由我们自己维护）
          if (normalized.endsWith('MEMORY.md')) return

          const fullPath = `${dir.replace(/\\/g, '/')}/${normalized}`
          // 跳过自身写入
          if (this.selfWritePaths.has(fullPath)) return

          this.handleEvent(fullPath, scope)
        })

        watcher.on('error', () => { /* 静默 */ })
        this.watchers.push(watcher)
      } catch {
        // 目录不可监听，静默跳过
      }
    }
  }

  /** 停止所有监听 */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    for (const w of this.watchers) {
      w.close()
    }
    this.watchers = []
    this.pendingChanges.clear()
    this.selfWritePaths.clear()
  }

  private handleEvent(fullPath: string, scope: MemoryScope): void {
    // 用 stat 判断是新增/修改还是删除
    stat(fullPath, (err, stats) => {
      try {
        if (err || !stats) {
          this.pendingChanges.set(fullPath, { filePath: fullPath, type: 'delete', scope })
        } else if (stats.isFile()) {
          // rename 事件可能是新建或修改，统一当 change 处理
          const existing = this.pendingChanges.get(fullPath)
          this.pendingChanges.set(fullPath, {
            filePath: fullPath,
            type: existing?.type === 'delete' ? 'add' : 'change',
            scope,
          })
        }
        this.scheduleFlush()
      } catch {
        // 静默
      }
    })
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flush(), DEBOUNCE_MS)
  }

  private flush(): void {
    if (this.pendingChanges.size === 0) return
    const changes = [...this.pendingChanges.values()]
    this.pendingChanges.clear()
    try {
      this.callback(changes)
    } catch {
      // 回调异常不影响 watcher 运行
    }
  }
}

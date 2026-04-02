// src/plugin/storage.ts

/**
 * 插件专属 key-value 存储 — 基于 JSON 文件持久化。
 * 每个插件一个 storage.json，位于 ~/.ccode/plugins/<name>/storage.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PluginStorage } from './types.js'

export function createPluginStorage(storagePath: string): PluginStorage {
  let data: Record<string, unknown> = {}

  // 加载已有数据
  if (existsSync(storagePath)) {
    try {
      data = JSON.parse(readFileSync(storagePath, 'utf-8'))
    } catch {
      /* 存储文件不存在或损坏，使用空对象 */
      data = {}
    }
  }

  function save(): void {
    try {
      const dir = dirname(storagePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      // 写入失败静默忽略
    }
  }

  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (data[key] as T) ?? defaultValue
    },
    set<T>(key: string, value: T): void {
      data[key] = value
      save()
    },
    delete(key: string): void {
      delete data[key]
      save()
    },
    keys(): string[] {
      return Object.keys(data)
    },
  }
}

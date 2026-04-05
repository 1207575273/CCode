// src/config/config-manager.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ProviderConfig {
  apiKey: string
  baseURL?: string
  /** 协议类型：anthropic 原生 或 openai 兼容（默认 openai） */
  protocol?: 'anthropic' | 'openai'
  models: string[]
}

export interface CCodeConfig {
  defaultProvider: string
  defaultModel: string
  providers: Record<string, ProviderConfig | undefined>
  statusBar?: boolean
}

const DEFAULT_CONFIG: CCodeConfig = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  providers: {
    anthropic: {
      apiKey: '',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
    glm: {
      apiKey: '',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      models: ['glm-4-flash', 'glm-4-air', 'glm-4'],
    },
    openai: {
      apiKey: '',
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
  },
  statusBar: true,
}

export class ConfigManager {
  readonly #configPath: string
  #cached: CCodeConfig | null = null
  #cachedMtime: number = 0

  constructor(baseDir: string = join(homedir(), '.ccode')) {
    this.#configPath = join(baseDir, 'config.json')
  }

  load(): CCodeConfig {
    if (!existsSync(this.#configPath)) {
      this.#ensureDir()
      this.#write(DEFAULT_CONFIG)
      this.#cached = { ...DEFAULT_CONFIG }
      return this.#cached
    }

    // mtime 未变则返回缓存，避免重复读磁盘
    try {
      const mtime = statSync(this.#configPath).mtimeMs
      if (this.#cached && mtime === this.#cachedMtime) return this.#cached
      this.#cachedMtime = mtime
    } catch {
      // statSync 失败，走无缓存路径
    }

    try {
      const raw = readFileSync(this.#configPath, 'utf-8')
      const loaded = JSON.parse(raw) as Partial<CCodeConfig>
      // 与默认值合并：已有字段保留，缺失字段补充默认值（向前兼容旧配置）
      this.#cached = { ...DEFAULT_CONFIG, ...loaded }
      return this.#cached
    } catch {
      this.#cached = { ...DEFAULT_CONFIG }
      return this.#cached
    }
  }

  save(config: CCodeConfig): void {
    this.#ensureDir()
    this.#write(config)
    this.#cached = config
    try { this.#cachedMtime = statSync(this.#configPath).mtimeMs } catch { /* ignore */ }
  }

  #ensureDir(): void {
    const dir = this.#configPath.replace(/[/\\][^/\\]+$/, '')
    mkdirSync(dir, { recursive: true })
  }

  #write(config: CCodeConfig): void {
    writeFileSync(this.#configPath, JSON.stringify(config, null, 2), 'utf-8')
  }
}

// 全局单例，使用默认路径 ~/.ccode/config.json
export const configManager = new ConfigManager()

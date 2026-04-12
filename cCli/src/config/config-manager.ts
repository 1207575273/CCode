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
  /** 支持多模态图片理解的模型子集（models 的子集），为空或不填 = 全部不支持 */
  visionModels?: string[]
}

export interface EmbeddingConfig {
  apiKey?: string
  baseURL?: string
  model?: string
  dimension?: number
}

export interface MemoryConfig {
  enabled?: boolean
  embedding?: EmbeddingConfig
}

export interface CCodeConfig {
  defaultProvider: string
  defaultModel: string
  /** 子 Agent 默认模型（不配则继承主 Agent 当前模型），Provider 自动从 providers 中查找 */
  subAgentModel?: string
  providers: Record<string, ProviderConfig | undefined>
  statusBar?: boolean
  /** 记忆系统配置（embedding 向量检索） */
  memory?: MemoryConfig
}

const DEFAULT_CONFIG: CCodeConfig = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  providers: {
    anthropic: {
      apiKey: '',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      visionModels: [],  // 默认关闭，用户手动开启
    },
    glm: {
      apiKey: '',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      models: ['glm-4-flash', 'glm-4-air', 'glm-4'],
      visionModels: [],
    },
    openai: {
      apiKey: '',
      models: ['gpt-4o', 'gpt-4o-mini'],
      visionModels: [],
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
      const merged = { ...DEFAULT_CONFIG, ...loaded }
      this.#cached = merged

      // 检测是否有新增默认字段需要回写（让用户在文件中看到新配置项）
      const defaultKeys = Object.keys(DEFAULT_CONFIG) as (keyof CCodeConfig)[]
      const hasMissingKeys = defaultKeys.some(k => !(k in loaded))
      if (hasMissingKeys) {
        this.#write(merged)
        try { this.#cachedMtime = statSync(this.#configPath).mtimeMs } catch { /* ignore */ }
      }

      return this.#cached
    } catch {
      this.#cached = { ...DEFAULT_CONFIG }
      return this.#cached
    }
  }

  /** 检查指定 provider + model 是否支持图片理解 */
  isVisionEnabled(provider: string, model: string): boolean {
    const config = this.load()
    const prov = config.providers[provider]
    if (!prov?.visionModels?.length) return false
    // 双重检查：模型必须在 models 列表中，且在 visionModels 白名单中
    return prov.models.includes(model) && prov.visionModels.includes(model)
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

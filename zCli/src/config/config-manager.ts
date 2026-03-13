// src/config/config-manager.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ProviderConfig {
  apiKey: string
  baseURL?: string
  /** 协议类型：anthropic 原生 或 openai 兼容（默认 openai） */
  protocol?: 'anthropic' | 'openai'
  models: string[]
}

export interface ZCliConfig {
  defaultProvider: string
  defaultModel: string
  providers: Record<string, ProviderConfig | undefined>
}

const DEFAULT_CONFIG: ZCliConfig = {
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
}

export class ConfigManager {
  readonly #configPath: string

  constructor(baseDir: string = join(homedir(), '.zcli')) {
    this.#configPath = join(baseDir, 'config.json')
  }

  load(): ZCliConfig {
    if (!existsSync(this.#configPath)) {
      this.#ensureDir()
      this.#write(DEFAULT_CONFIG)
      return { ...DEFAULT_CONFIG }
    }
    try {
      const raw = readFileSync(this.#configPath, 'utf-8')
      return JSON.parse(raw) as ZCliConfig
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  save(config: ZCliConfig): void {
    this.#ensureDir()
    this.#write(config)
  }

  #ensureDir(): void {
    const dir = this.#configPath.replace(/[/\\][^/\\]+$/, '')
    mkdirSync(dir, { recursive: true })
  }

  #write(config: ZCliConfig): void {
    writeFileSync(this.#configPath, JSON.stringify(config, null, 2), 'utf-8')
  }
}

// 全局单例，使用默认路径 ~/.zcli/config.json
export const configManager = new ConfigManager()

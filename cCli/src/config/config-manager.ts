// src/config/config-manager.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, Document } from 'yaml'
import { ccodeHome } from '../platform/path-utils.js'

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
  /** embedding 复用的 Provider 名（用于在 UI 中归类，可选） */
  provider?: string
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
  memory: {
    enabled: false,
    embedding: {
      apiKey: 'your-embedding-api-key',
      baseURL: 'https://your-embedding-api-base-url/v4',
      model: 'your-embedding-model',
      dimension: 1024,
    },
  },
}

/** YAML 文件头注释 — 解释格式、迁移来源与每个字段的作用与配法（JSON 做不到注释，这是切 YAML 的核心收益）。 */
const YAML_HEADER = [
  ' ===================================================================',
  ' ccode 全局配置（YAML 格式，支持注释；手动编辑保存后即生效）',
  ' 旧版 config.json 首次启动会自动迁移到本文件，原文件备份为 config.json.bak',
  ' ===================================================================',
  '',
  ' [defaultProvider]  默认使用的 Provider 名称，必须是下面 providers 里的某个 key',
  '                    例：glm、openrouter',
  '',
  ' [defaultModel]     默认模型名，必须出现在所选 Provider 的 models 列表中',
  '                    例：glm-5',
  '',
  ' [subAgentModel]    子 Agent（任务分解 / 并行执行）默认模型，可跨 Provider；',
  '                    Provider 自动按模型名从 providers 反查；留空则继承主 Agent 当前模型',
  '',
  ' [providers]        各 LLM 服务商配置，key 为自定义名称（被 defaultProvider 引用）',
  '   <name>.apiKey        该服务商密钥（必填）',
  '   <name>.baseURL       接口地址；留空则用对应协议的官方默认地址',
  '   <name>.protocol      接口协议：anthropic（原生）| openai（兼容），不填默认 openai',
  '   <name>.models        该服务商可用模型列表（数组）',
  '   <name>.visionModels  支持图片理解的模型子集（必须是 models 的子集）；不填 = 全部不支持',
  '',
  ' [statusBar]        是否显示底部状态栏（true / false）',
  '',
  ' [memory]           记忆系统（长期记忆 + 向量检索）',
  '   enabled              是否开启记忆系统（true / false）',
  '   embedding.apiKey     embedding 向量服务密钥',
  '   embedding.baseURL    embedding 接口地址',
  '   embedding.model      embedding 模型名（如 embedding-3）',
  '   embedding.dimension  向量维度，需与模型匹配（如 1024 / 2048）',
  '   embedding.provider   归类用的 Provider 名（可选，仅用于界面展示）',
  ' ===================================================================',
].join('\n')

/**
 * 递归按 key 排序生成规范化结构，用于迁移回读校验的深度相等比较。
 * 不依赖对象字面量顺序，只比较内容。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = canonicalize(obj[k])
      return acc
    }, {})
  }
  return value
}

/** 内容深度相等（忽略 key 顺序）。迁移闸门用：YAML 回读结果必须与原 JSON 内容一致才算切换成功。 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
}

export class ConfigManager {
  readonly #baseDir: string
  /** 主写入路径：统一为 config.yml */
  readonly #ymlPath: string
  /** 兼容读取：部分用户用 .yaml 后缀 */
  readonly #yamlPath: string
  /** 旧 JSON 配置（双通道读取 + 迁移源） */
  readonly #jsonPath: string

  #cached: CCodeConfig | null = null
  #cachedMtime: number = 0
  /** 当前真源文件路径（决定 save 写哪个文件 / 缓存比对哪个 mtime） */
  #activePath: string = ''
  /** 上一次 load 的结果，供 ensureInitialized 生成诊断（无需再用文件系统快照反推） */
  #lastOutcome: 'created' | 'migrated' | 'migration-failed' | 'loaded' | 'recovered' = 'loaded'

  constructor(baseDir: string = ccodeHome()) {
    this.#baseDir = baseDir
    this.#ymlPath = join(baseDir, 'config.yml')
    this.#yamlPath = join(baseDir, 'config.yaml')
    this.#jsonPath = join(baseDir, 'config.json')
  }

  /** 已存在的 YAML 路径（优先 .yml，其次 .yaml），都不存在返回 null。 */
  #existingYamlPath(): string | null {
    if (existsSync(this.#ymlPath)) return this.#ymlPath
    if (existsSync(this.#yamlPath)) return this.#yamlPath
    return null
  }

  load(): CCodeConfig {
    // 缓存短路：真源已确定时只比对其 mtime，稳态零额外 existsSync（load 是 UI 每条消息的热路径）
    if (this.#cached && this.#activePath) {
      let mtime: number | null = null
      try { mtime = statSync(this.#activePath).mtimeMs } catch { mtime = null }
      if (mtime !== null) {
        if (mtime === this.#cachedMtime) return this.#cached
        // 真源文件已变：原地重读（不重探后缀、不重试迁移；activePath 指向 JSON 即降级态）
        return this.#loadFrom(this.#activePath, this.#activePath === this.#jsonPath ? 'json' : 'yaml')
      }
      // 真源文件消失 → 落到冷路径重新探测
    }

    // 冷路径：首次加载 / 真源失效，完整探测真源
    const yml = this.#existingYamlPath()
    if (yml) return this.#loadFrom(yml, 'yaml')
    if (existsSync(this.#jsonPath)) return this.#migrate()

    // 都不存在 → 写默认 YAML
    this.#ensureDir()
    this.#writeYaml(DEFAULT_CONFIG)
    this.#lastOutcome = 'created'
    return this.#setCache({ ...DEFAULT_CONFIG }, this.#ymlPath)
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
    // 写回当前真源；迁移失败仍以 JSON 为真源时保持写 JSON，否则统一写 YAML
    if (this.#activePath === this.#jsonPath) {
      this.#writeJson(config)
    } else {
      this.#writeYaml(config)
      this.#activePath = this.#ymlPath
    }
    this.#cached = config
    try { this.#cachedMtime = statSync(this.#activePath).mtimeMs } catch { /* 保存后刷新 mtime 失败，下次 load 会重新读取 */ }
  }

  /**
   * 启动期初始化：确保配置存在、必要时迁移、做 apiKey 诊断。
   * 供 initializer 调用，取代其直接读写 config.json 的逻辑（消除第二条配置 IO 通道）。
   */
  ensureInitialized(): { created: string[]; warnings: string[] } {
    const created: string[] = []
    const warnings: string[] = []

    const cfg = this.load() // 触发：创建默认 / 迁移 / 损坏恢复，结果记录在 #lastOutcome

    switch (this.#lastOutcome) {
      case 'created':
        created.push(this.#ymlPath)
        break
      case 'migrated':
        warnings.push(`配置已从 config.json 迁移为 ${this.#ymlPath}（旧文件已备份为 config.json.bak）`)
        break
      case 'migration-failed':
        warnings.push('config.json 迁移 YAML 回读校验未通过，已降级继续使用 config.json（数据未丢失）')
        break
      default:
        break
    }

    // apiKey 诊断
    const providerName = cfg.defaultProvider
    if (providerName) {
      const providerCfg = cfg.providers[providerName]
      if (!providerCfg) {
        warnings.push(`当前 provider "${providerName}" 未在 providers 中配置`)
      } else if (!providerCfg.apiKey) {
        warnings.push(`当前 provider "${providerName}" 的 apiKey 为空，请在 ${this.#activePath} 中配置`)
      }
    }

    return { created, warnings }
  }

  // ---------- 内部 ----------

  /** 从指定文件按格式解析、与默认值合并、写入缓存。损坏则备份并重置为默认 YAML。 */
  #loadFrom(path: string, format: 'yaml' | 'json'): CCodeConfig {
    try {
      const raw = readFileSync(path, 'utf-8')
      const loaded = (format === 'yaml' ? parseYaml(raw) : JSON.parse(raw)) as Partial<CCodeConfig> | null
      const merged = { ...DEFAULT_CONFIG, ...(loaded ?? {}) }
      this.#lastOutcome = 'loaded'
      return this.#setCache(merged, path)
    } catch {
      // 解析失败：备份损坏文件 + 重置为默认 YAML（保留旧 initializer 的容错行为）
      this.#backupCorrupt(path)
      this.#ensureDir()
      this.#writeYaml(DEFAULT_CONFIG)
      this.#lastOutcome = 'recovered'
      return this.#setCache({ ...DEFAULT_CONFIG }, this.#ymlPath)
    }
  }

  /**
   * 将旧 config.json 迁移为 config.yml。
   * 闸门：生成后回读 YAML，内容与原 JSON 深度相等才认为「切换成功」，
   * 成功才备份并以 YAML 为真源；失败则删除半成品、降级继续用 JSON，绝不丢数据。
   */
  #migrate(): CCodeConfig {
    let parsed: Partial<CCodeConfig>
    try {
      parsed = JSON.parse(readFileSync(this.#jsonPath, 'utf-8')) as Partial<CCodeConfig>
    } catch {
      // JSON 本身损坏 → 备份 + 默认 YAML
      this.#backupCorrupt(this.#jsonPath)
      this.#ensureDir()
      this.#writeYaml(DEFAULT_CONFIG)
      this.#lastOutcome = 'recovered'
      return this.#setCache({ ...DEFAULT_CONFIG }, this.#ymlPath)
    }

    // 生成 YAML 并回读校验。写入原始 parsed 而非 merged：闸门要确认「序列化无损」，
    // 写 merged 会引入 DEFAULT_CONFIG 默认字段，使 deepEqual 必然不等。
    this.#ensureDir()
    this.#writeYaml(parsed)

    let reparsed: unknown
    try {
      reparsed = parseYaml(readFileSync(this.#ymlPath, 'utf-8'))
    } catch {
      reparsed = undefined
    }

    const merged = { ...DEFAULT_CONFIG, ...parsed }
    if (reparsed !== undefined && deepEqual(reparsed, parsed)) {
      // 切换成功 → 备份 JSON（原子重命名），此后以 YAML 为真源
      try {
        renameSync(this.#jsonPath, this.#jsonPath + '.bak')
      } catch {
        // 重命名失败不阻塞：YAML 已是真源，JSON 残留会被忽略（YAML 优先）
      }
      this.#lastOutcome = 'migrated'
      return this.#setCache(merged, this.#ymlPath)
    }

    // 校验失败 → 删除半成品 YAML，降级用 JSON，绝不删 JSON
    try {
      rmSync(this.#ymlPath, { force: true })
    } catch {
      // 删除失败忽略：activePath 已指向 JSON，残留 YAML 不会被当真源
    }
    this.#lastOutcome = 'migration-failed'
    return this.#setCache(merged, this.#jsonPath)
  }

  /** 生成带头注释的 YAML 文本。 */
  #serializeYaml(config: unknown): string {
    const doc = new Document(config)
    doc.commentBefore = YAML_HEADER
    return String(doc)
  }

  #setCache(config: CCodeConfig, path: string): CCodeConfig {
    this.#cached = config
    this.#activePath = path
    try { this.#cachedMtime = statSync(path).mtimeMs } catch { this.#cachedMtime = 0 }
    return config
  }

  #ensureDir(): void {
    mkdirSync(this.#baseDir, { recursive: true })
  }

  #writeYaml(config: unknown): void {
    writeFileSync(this.#ymlPath, this.#serializeYaml(config), 'utf-8')
  }

  #writeJson(config: CCodeConfig): void {
    writeFileSync(this.#jsonPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  /** 备份损坏文件为 <file>.bak（不阻塞启动）。 */
  #backupCorrupt(path: string): void {
    try {
      copyFileSync(path, path + '.bak')
    } catch {
      // 备份失败也不阻塞：重置默认配置比保留损坏文件更重要
    }
  }
}

// 全局单例，路径经 ccodeHome() 防御式解析（默认 <home>/.ccode/config.yml，兼容读取旧 config.json）
export const configManager = new ConfigManager()

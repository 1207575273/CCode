// src/core/initializer.ts

/**
 * 启动初始化器 — 在 CLI 入口最早期执行，确保运行环境就绪。
 *
 * 职责：
 * 1. 确保 ~/.ccode/ 目录存在（全局配置）
 * 2. 确保 config.json 存在且关键字段完整
 * 3. 确保 .mcp.json 存在（空模板）
 * 4. 确保项目级 .ccode/ 目录和 settings.local.json 存在（项目权限配置）
 * 5. 启动诊断：当前 provider 是否配了 apiKey
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 初始化基础目录路径 */
const CCODE_HOME = join(homedir(), '.ccode')
const CONFIG_PATH = join(CCODE_HOME, 'config.json')
const MCP_CONFIG_PATH = join(CCODE_HOME, '.mcp.json')

/** config.json 默认模板 */
const DEFAULT_CONFIG = {
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

/** .mcp.json 默认模板 */
const DEFAULT_MCP_CONFIG = {
  mcpServers: {},
}

/** settings.local.json 默认模板 — 空权限，遵循默认询问机制 */
const DEFAULT_LOCAL_SETTINGS = {
  permissions: {
    allow: [],
  },
}

export interface InitDiagnostic {
  /** 是否有配置问题需要警告用户 */
  warnings: string[]
  /** 初始化过程中创建了哪些文件 */
  created: string[]
}

/**
 * 执行启动初始化，返回诊断信息。
 * 幂等：已存在的文件不会被覆盖。
 */
export function initialize(): InitDiagnostic {
  const warnings: string[] = []
  const created: string[] = []

  // 1. 确保 ~/.ccode/ 目录存在
  if (!existsSync(CCODE_HOME)) {
    mkdirSync(CCODE_HOME, { recursive: true })
  }

  // 2. 确保 config.json 存在且结构完整
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    created.push(CONFIG_PATH)
  } else {
    // 已存在：校验关键字段，缺失则补全
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      const config = JSON.parse(raw) as Record<string, unknown>
      let patched = false

      if (!config['defaultProvider'] || typeof config['defaultProvider'] !== 'string') {
        config['defaultProvider'] = DEFAULT_CONFIG.defaultProvider
        patched = true
      }
      if (!config['defaultModel'] || typeof config['defaultModel'] !== 'string') {
        config['defaultModel'] = DEFAULT_CONFIG.defaultModel
        patched = true
      }
      if (!config['providers'] || typeof config['providers'] !== 'object') {
        config['providers'] = DEFAULT_CONFIG.providers
        patched = true
      }

      if (patched) {
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
        warnings.push('config.json 缺少关键字段，已自动补全')
      }
    } catch {
      // JSON 解析失败：备份后重写
      const backupPath = CONFIG_PATH + '.bak'
      try {
        const broken = readFileSync(CONFIG_PATH, 'utf-8')
        writeFileSync(backupPath, broken, 'utf-8')
      } catch { /* 备份失败也不阻塞 */ }
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      warnings.push(`config.json 格式损坏，已备份到 ${backupPath} 并重置`)
    }
  }

  // 3. 确保 .mcp.json 存在
  if (!existsSync(MCP_CONFIG_PATH)) {
    writeFileSync(MCP_CONFIG_PATH, JSON.stringify(DEFAULT_MCP_CONFIG, null, 2), 'utf-8')
    created.push(MCP_CONFIG_PATH)
  }

  // 4. 确保项目级 .ccode/settings.local.json 存在
  const projectZcliDir = join(process.cwd(), '.ccode')
  const localSettingsPath = join(projectZcliDir, 'settings.local.json')
  if (!existsSync(localSettingsPath)) {
    if (!existsSync(projectZcliDir)) {
      mkdirSync(projectZcliDir, { recursive: true })
    }
    writeFileSync(localSettingsPath, JSON.stringify(DEFAULT_LOCAL_SETTINGS, null, 2), 'utf-8')
    created.push(localSettingsPath)
  }

  // 5. 启动诊断：检查当前 provider 的 apiKey
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw) as {
      defaultProvider?: string
      providers?: Record<string, { apiKey?: string } | undefined>
    }
    const providerName = config.defaultProvider
    if (providerName) {
      const providerCfg = config.providers?.[providerName]
      if (!providerCfg) {
        warnings.push(`当前 provider "${providerName}" 未在 providers 中配置`)
      } else if (!providerCfg.apiKey) {
        warnings.push(`当前 provider "${providerName}" 的 apiKey 为空，请在 ~/.ccode/config.json 中配置`)
      }
    }
  } catch { /* 诊断失败不阻塞启动 */ }

  return { warnings, created }
}

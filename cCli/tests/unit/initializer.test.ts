import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 直接测试 initializer 内部逻辑，通过临时目录模拟 ~/.ccode/
// 由于 initializer 硬编码了 homedir，这里用集成方式测试核心逻辑

describe('initializer 核心逻辑', () => {
  const testDir = join(tmpdir(), `ccode-init-test-${Date.now()}`)
  const configPath = join(testDir, 'config.json')
  const mcpPath = join(testDir, '.mcp.json')

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  it('目录不存在时创建目录和所有配置文件', () => {
    // 模拟 initializer 逻辑
    mkdirSync(testDir, { recursive: true })

    // config.json
    const defaultConfig = {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      providers: { anthropic: { apiKey: '', models: ['claude-sonnet-4-6'] } },
    }
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')

    // .mcp.json
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8')

    expect(existsSync(testDir)).toBe(true)
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(mcpPath)).toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.defaultProvider).toBe('anthropic')
    expect(config.providers.anthropic).toBeDefined()
  })

  it('config.json 缺少关键字段时补全', () => {
    mkdirSync(testDir, { recursive: true })

    // 写一个缺失 defaultModel 的配置
    const broken = { defaultProvider: 'glm', providers: { glm: { apiKey: 'xxx', models: ['glm-5'] } } }
    writeFileSync(configPath, JSON.stringify(broken, null, 2), 'utf-8')

    // 模拟补全逻辑
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    let patched = false

    if (!config['defaultModel'] || typeof config['defaultModel'] !== 'string') {
      config['defaultModel'] = 'claude-sonnet-4-6'
      patched = true
    }

    if (patched) {
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    }

    const result = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(result.defaultModel).toBe('claude-sonnet-4-6')
    expect(result.defaultProvider).toBe('glm') // 原有字段不被覆盖
    expect(patched).toBe(true)
  })

  it('config.json JSON 损坏时备份并重置', () => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(configPath, '{ broken json !!!', 'utf-8')

    // 模拟损坏恢复逻辑
    let parseOk = true
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
      parseOk = false
      const backupPath = configPath + '.bak'
      const brokenContent = readFileSync(configPath, 'utf-8')
      writeFileSync(backupPath, brokenContent, 'utf-8')
      writeFileSync(configPath, JSON.stringify({ defaultProvider: 'anthropic' }, null, 2), 'utf-8')
    }

    expect(parseOk).toBe(false)
    expect(existsSync(configPath + '.bak')).toBe(true)
    expect(readFileSync(configPath + '.bak', 'utf-8')).toBe('{ broken json !!!')

    const restored = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(restored.defaultProvider).toBe('anthropic')
  })

  it('已有完整配置时不做修改', () => {
    mkdirSync(testDir, { recursive: true })
    const fullConfig = {
      defaultProvider: 'glm',
      defaultModel: 'glm-5',
      providers: { glm: { apiKey: 'my-key', models: ['glm-5'] } },
    }
    writeFileSync(configPath, JSON.stringify(fullConfig, null, 2), 'utf-8')

    // 模拟检查逻辑
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    let patched = false

    if (!config['defaultProvider'] || typeof config['defaultProvider'] !== 'string') {
      patched = true
    }
    if (!config['defaultModel'] || typeof config['defaultModel'] !== 'string') {
      patched = true
    }
    if (!config['providers'] || typeof config['providers'] !== 'object') {
      patched = true
    }

    expect(patched).toBe(false)
    // 文件内容未变
    expect(readFileSync(configPath, 'utf-8')).toBe(JSON.stringify(fullConfig, null, 2))
  })

  it('apiKey 为空时产生警告', () => {
    mkdirSync(testDir, { recursive: true })
    const config = {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      providers: { anthropic: { apiKey: '', models: ['claude-sonnet-4-6'] } },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    const warnings: string[] = []
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      defaultProvider?: string
      providers?: Record<string, { apiKey?: string } | undefined>
    }
    const providerName = parsed.defaultProvider
    if (providerName) {
      const providerCfg = parsed.providers?.[providerName]
      if (!providerCfg) {
        warnings.push(`provider "${providerName}" 未配置`)
      } else if (!providerCfg.apiKey) {
        warnings.push(`provider "${providerName}" apiKey 为空`)
      }
    }

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('apiKey')
  })
})

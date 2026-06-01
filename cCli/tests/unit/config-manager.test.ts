import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'

// 用临时目录隔离测试，不污染真实 ~/.ccode
let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `ccode-test-${Date.now()}-${Math.floor(performance.now())}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// 延迟 import，让 testDir 先创建好
async function getManager() {
  const { ConfigManager } = await import('@config/config-manager.js')
  return new ConfigManager(testDir)
}

describe('ConfigManager', () => {
  it('不存在时创建默认 config.yml（不再是 json）', async () => {
    const cm = await getManager()
    const cfg = cm.load()
    expect(cfg.defaultProvider).toBe('anthropic')
    expect(cfg.providers).toHaveProperty('anthropic')
    expect(existsSync(join(testDir, 'config.yml'))).toBe(true)
    expect(existsSync(join(testDir, 'config.json'))).toBe(false)
  })

  it('默认 config.yml 带头注释', async () => {
    const cm = await getManager()
    cm.load()
    const text = readFileSync(join(testDir, 'config.yml'), 'utf-8')
    expect(text).toContain('#')
    expect(text).toContain('ccode')
  })

  it('已存在 yml 时正确读取', async () => {
    const cm = await getManager()
    cm.load() // 创建默认
    cm.save({ defaultProvider: 'glm', defaultModel: 'glm-4-flash', providers: {} })
    const cfg = cm.load()
    expect(cfg.defaultProvider).toBe('glm')
    expect(cfg.defaultModel).toBe('glm-4-flash')
  })

  it('save 后写入 yml 且 load 数据一致', async () => {
    const cm = await getManager()
    const newCfg = {
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: {
        openai: { apiKey: 'sk-test', models: ['gpt-4o'] },
      },
    }
    cm.save(newCfg)
    expect(existsSync(join(testDir, 'config.yml'))).toBe(true)
    const loaded = cm.load()
    expect(loaded.defaultProvider).toBe('openai')
    expect(loaded.providers.openai?.apiKey).toBe('sk-test')
  })

  describe('双通道迁移', () => {
    it('只有 config.json 时自动迁移为 config.yml 并备份 json', async () => {
      const legacy = {
        defaultProvider: 'glm',
        defaultModel: 'glm-5',
        providers: { glm: { apiKey: 'real-key', models: ['glm-5'] } },
        statusBar: true,
      }
      writeFileSync(join(testDir, 'config.json'), JSON.stringify(legacy, null, 2), 'utf-8')

      const cm = await getManager()
      const cfg = cm.load()

      expect(cfg.defaultProvider).toBe('glm')
      expect(cfg.providers.glm?.apiKey).toBe('real-key')
      // 切换成功：yml 生成、json 备份、原 json 不再存在
      expect(existsSync(join(testDir, 'config.yml'))).toBe(true)
      expect(existsSync(join(testDir, 'config.json.bak'))).toBe(true)
      expect(existsSync(join(testDir, 'config.json'))).toBe(false)
    })

    it('迁移保留 interface 未声明的嵌套字段（memory.embedding.provider）', async () => {
      const legacy = {
        defaultProvider: 'glm',
        defaultModel: 'glm-5',
        providers: { glm: { apiKey: 'k', models: ['glm-5'] } },
        memory: {
          enabled: true,
          embedding: { apiKey: 'ek', model: 'embedding-3', dimension: 2048, provider: 'glm' },
        },
      }
      writeFileSync(join(testDir, 'config.json'), JSON.stringify(legacy), 'utf-8')

      const cm = await getManager()
      cm.load()
      const yml = parseYaml(readFileSync(join(testDir, 'config.yml'), 'utf-8'))
      expect(yml.memory.embedding.provider).toBe('glm')
      expect(yml.memory.embedding.dimension).toBe(2048)
    })

    it('yml 与 json 同时存在时以 yml 为真源', async () => {
      writeFileSync(
        join(testDir, 'config.json'),
        JSON.stringify({ defaultProvider: 'json-one', defaultModel: 'm', providers: {} }),
        'utf-8',
      )
      writeFileSync(
        join(testDir, 'config.yml'),
        'defaultProvider: yml-one\ndefaultModel: m\nproviders: {}\n',
        'utf-8',
      )
      const cm = await getManager()
      expect(cm.load().defaultProvider).toBe('yml-one')
    })
  })

  describe('ensureInitialized', () => {
    it('首次初始化创建 yml 并返回 created', async () => {
      const cm = await getManager()
      const r = cm.ensureInitialized()
      expect(r.created.some((p) => p.endsWith('config.yml'))).toBe(true)
    })

    it('apiKey 为空时给出警告', async () => {
      writeFileSync(
        join(testDir, 'config.yml'),
        'defaultProvider: glm\ndefaultModel: glm-5\nproviders:\n  glm:\n    apiKey: ""\n    models: [glm-5]\n',
        'utf-8',
      )
      const cm = await getManager()
      const r = cm.ensureInitialized()
      expect(r.warnings.some((w) => w.includes('apiKey'))).toBe(true)
    })
  })
})

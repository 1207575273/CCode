import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 用临时目录隔离测试，不污染真实 ~/.ccode
let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `ccode-test-${Date.now()}`)
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
  it('不存在时创建默认 config 文件', async () => {
    const cm = await getManager()
    const cfg = cm.load()
    expect(cfg.defaultProvider).toBe('anthropic')
    expect(cfg.providers).toHaveProperty('anthropic')
    expect(existsSync(join(testDir, 'config.json'))).toBe(true)
  })

  it('已存在时正确读取', async () => {
    const cm = await getManager()
    cm.load() // 创建默认
    cm.save({ defaultProvider: 'glm', defaultModel: 'glm-4-flash', providers: {} })
    const cfg = cm.load()
    expect(cfg.defaultProvider).toBe('glm')
    expect(cfg.defaultModel).toBe('glm-4-flash')
  })

  it('save 后 load 数据一致', async () => {
    const cm = await getManager()
    const newCfg = {
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: {
        openai: { apiKey: 'sk-test', models: ['gpt-4o'] }
      }
    }
    cm.save(newCfg)
    const loaded = cm.load()
    expect(loaded.defaultProvider).toBe('openai')
    expect(loaded.providers.openai?.apiKey).toBe('sk-test')
  })
})

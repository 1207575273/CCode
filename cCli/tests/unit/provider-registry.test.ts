import { describe, it, expect } from 'vitest'
import { createProvider } from '@providers/registry.js'
import type { ZCliConfig } from '@config/config-manager.js'

const baseConfig: ZCliConfig = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  providers: {
    anthropic: { apiKey: 'sk-ant', models: ['claude-sonnet-4-6'] },
    glm: { apiKey: 'glm-key', baseURL: 'https://open.bigmodel.ai/api/paas/v4', models: ['glm-4-flash'] },
    openai: { apiKey: 'sk-oai', models: ['gpt-4o'] },
  },
}

describe('createProvider', () => {
  it('anthropic → AnthropicProvider', () => {
    const p = createProvider('anthropic', baseConfig)
    expect(p.name).toBe('anthropic')
    expect(p.protocol).toBe('native-anthropic')
  })

  it('glm → OpenAICompatProvider', () => {
    const p = createProvider('glm', baseConfig)
    expect(p.name).toBe('glm')
    expect(p.protocol).toBe('openai-compat')
  })

  it('openai → OpenAICompatProvider', () => {
    const p = createProvider('openai', baseConfig)
    expect(p.name).toBe('openai')
    expect(p.protocol).toBe('openai-compat')
  })

  it('未知 provider 抛出错误', () => {
    expect(() => createProvider('unknown', baseConfig)).toThrow()
  })

  it('provider 配置不存在时抛出错误', () => {
    const cfg = { ...baseConfig, providers: {} }
    expect(() => createProvider('anthropic', cfg)).toThrow()
  })
})

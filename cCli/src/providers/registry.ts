// src/providers/registry.ts
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatProvider } from './openai-compat.js'
import { ProviderWrapper } from './wrapper.js'
import type { LLMProvider } from './provider.js'
import type { CCodeConfig } from '@config/config-manager.js'

/**
 * 判断协议类型：
 * 1. 配置了 protocol 字段 → 直接使用
 * 2. 未配置 → provider 名为 'anthropic' 时走原生协议，其余走 OpenAI 兼容
 */
function resolveProtocol(providerName: string, protocol?: 'anthropic' | 'openai'): 'anthropic' | 'openai' {
  if (protocol) return protocol
  return providerName === 'anthropic' ? 'anthropic' : 'openai'
}

export function createProvider(providerName: string, config: CCodeConfig): LLMProvider {
  const providerCfg = config.providers[providerName]
  if (!providerCfg) {
    throw new Error(`Provider "${providerName}" 未在 ~/.ccode/config.json 中配置`)
  }

  const protocol = resolveProtocol(providerName, providerCfg.protocol)

  if (protocol === 'anthropic') {
    return new ProviderWrapper(new AnthropicProvider(providerName, providerCfg))
  }

  return new ProviderWrapper(new OpenAICompatProvider(providerName, providerCfg))
}

// ═══ Provider 缓存 ═══

const _providerCache = new Map<string, LLMProvider>()

/**
 * 获取或创建 Provider 实例。
 * 同一 providerName + apiKey 组合返回缓存实例，避免重复创建 SDK 客户端。
 */
export function getOrCreateProvider(providerName: string, config: CCodeConfig): LLMProvider {
  const cfg = config.providers[providerName]
  if (!cfg) {
    throw new Error(`Provider "${providerName}" 未在 ~/.ccode/config.json 中配置`)
  }
  const cacheKey = `${providerName}|${cfg.baseURL ?? ''}|${cfg.apiKey}`

  let cached = _providerCache.get(cacheKey)
  if (!cached) {
    cached = createProvider(providerName, config)
    _providerCache.set(cacheKey, cached)
  }
  return cached
}

/** 配置变更时清空 Provider 缓存（设置页保存后调用） */
export function clearProviderCache(): void {
  _providerCache.clear()
}

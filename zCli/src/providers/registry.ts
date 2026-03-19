// src/providers/registry.ts
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatProvider } from './openai-compat.js'
import { ProviderWrapper } from './wrapper.js'
import type { LLMProvider } from './provider.js'
import type { ZCliConfig } from '@config/config-manager.js'

/**
 * 判断协议类型：
 * 1. 配置了 protocol 字段 → 直接使用
 * 2. 未配置 → provider 名为 'anthropic' 时走原生协议，其余走 OpenAI 兼容
 */
function resolveProtocol(providerName: string, protocol?: 'anthropic' | 'openai'): 'anthropic' | 'openai' {
  if (protocol) return protocol
  return providerName === 'anthropic' ? 'anthropic' : 'openai'
}

export function createProvider(providerName: string, config: ZCliConfig): LLMProvider {
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

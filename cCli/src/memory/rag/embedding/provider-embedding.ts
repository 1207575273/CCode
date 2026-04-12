// src/memory/rag/embedding/provider-embedding.ts

/**
 * ProviderEmbedding — 基于现有 Provider 配置的 Embedding 实现。
 *
 * 设计文档：§3.4
 *
 * 复用 providers 配置中的 apiKey + baseURL，直接 fetch 调 /embeddings 端点。
 * 独立于 LLMProvider（后者只有 chat/countTokens），不复用 Provider 实例。
 * 支持 OpenAI 兼容协议（GLM、DeepSeek、OpenAI、MiniMax 等）。
 * Anthropic 协议不支持 Embedding。
 */

import type { EmbeddingProvider } from '@memory/types.js'

/** 构造参数 */
export interface ProviderEmbeddingOptions {
  /** 供应商名（用于日志） */
  providerName: string
  /** API Key */
  apiKey: string
  /** API Base URL（如 https://open.bigmodel.cn/api/coding/paas/v4） */
  baseURL: string
  /** Embedding 模型名（如 embedding-3、text-embedding-3-small） */
  model: string
  /** 向量维度（由模型决定，如 1024、1536） */
  dimension: number
  /** 单次批量最大文本数（默认 20） */
  maxBatchSize?: number
}

/** OpenAI 兼容的 /embeddings 响应格式 */
interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

export class ProviderEmbedding implements EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  readonly maxBatchSize: number

  private readonly apiKey: string
  private readonly baseURL: string
  private readonly model: string

  constructor(options: ProviderEmbeddingOptions) {
    this.name = options.providerName
    this.apiKey = options.apiKey
    this.baseURL = options.baseURL.replace(/\/$/, '') // 去尾部斜杠
    this.model = options.model
    this.dimension = options.dimension
    this.maxBatchSize = options.maxBatchSize ?? 20
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]!
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const results: number[][] = []

    // 按 maxBatchSize 分批
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize)
      const batchResults = await this.callApi(batch)
      results.push(...batchResults)
    }

    return results
  }

  async isAvailable(): Promise<boolean> {
    try {
      // 用极短文本测试连通性
      await this.callApi(['test'])
      return true
    } catch {
      // Embedding API 连通性测试失败（网络不通或鉴权失败），视为不可用
      return false
    }
  }

  private async callApi(inputs: string[]): Promise<number[][]> {
    const url = `${this.baseURL}/embeddings`
    const body = JSON.stringify({
      model: this.model,
      input: inputs,
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(`Embedding API 调用失败 [${response.status}]: ${errorText}`)
    }

    const json = await response.json() as EmbeddingResponse

    // 按 index 排序，确保返回顺序与输入一致
    const sorted = json.data.sort((a, b) => a.index - b.index)
    return sorted.map(d => d.embedding)
  }
}

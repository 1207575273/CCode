// src/providers/retry.ts

/**
 * LLM API 重试包装器。
 *
 * 设计要点：
 * - 只在连接建立阶段（第一个 chunk 消费前）重试，流中途断开不重试
 * - 429 Rate Limit：指数退避（1s → 2s → 4s），尊重 Retry-After header
 * - 网络错误（ECONNREFUSED/ETIMEDOUT/ECONNRESET）：固定间隔重试
 * - 5xx 服务端错误：重试 1 次
 * - 4xx（非 429）：不重试，直接报错
 * - 每次重试写入 debug.log
 */

import { dbg } from '../debug.js'
import type { StreamChunk } from '@core/types.js'

/** 重试配置 */
export interface RetryConfig {
  maxRetries: number       // 默认 3
  baseDelayMs: number      // 默认 1000
  maxDelayMs: number       // 默认 30000
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
}

/** 可重试的网络错误码 */
const RETRYABLE_NETWORK_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'socket hang up']

/** 错误信息友好化映射（中英双语） */
const ERROR_HINTS: Record<string, string> = {
  '401': '认证失败 / Authentication failed — 请检查 apiKey 是否正确',
  '403': '访问被拒 / Access denied — API Key 可能无权访问该模型',
  '404': '模型不存在 / Model not found — 请确认模型名称拼写正确',
  '429': '请求频率超限 / Rate limited',
  '500': '服务端内部错误 / Internal server error',
  '502': '网关错误 / Bad gateway — 服务可能正在重启',
  '503': '服务暂不可用 / Service unavailable — 稍后重试',
  'ECONNREFUSED': '连接被拒 / Connection refused — 请检查 baseURL 是否正确，服务是否启动',
  'ETIMEDOUT': '连接超时 / Connection timeout — 请检查网络连接或 baseURL',
  'ECONNRESET': '连接被重置 / Connection reset — 网络不稳定，请重试',
}

/** 从错误对象中提取 HTTP 状态码 */
export function extractStatusCode(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null
  // Anthropic SDK: err.status
  if ('status' in err && typeof (err as { status: unknown }).status === 'number') {
    return (err as { status: number }).status
  }
  // LangChain / fetch: err.statusCode 或 message 中的数字
  if ('statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number') {
    return (err as { statusCode: number }).statusCode
  }
  // 从 message 中提取 "status code 429" 或 "Error 429" 等模式
  const msg = err instanceof Error ? err.message : String(err)
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/)
  return match ? parseInt(match[1]!, 10) : null
}

/** 从错误对象中提取网络错误码 */
function extractNetworkCode(err: unknown): string | null {
  if (err == null || typeof err !== 'object') return null
  if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  const msg = err instanceof Error ? err.message : String(err)
  for (const code of RETRYABLE_NETWORK_CODES) {
    if (msg.includes(code)) return code
  }
  return null
}

/** 从 Anthropic 错误中提取 Retry-After 秒数 */
function extractRetryAfter(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null
  // Anthropic SDK: err.headers?.['retry-after']
  const headers = (err as { headers?: Record<string, string> }).headers
  if (headers?.['retry-after']) {
    const seconds = parseInt(headers['retry-after'], 10)
    if (!isNaN(seconds) && seconds > 0) return seconds
  }
  return null
}

/** 判断错误是否可重试，返回建议等待时间（ms），不可重试返回 null */
function getRetryDelay(err: unknown, attempt: number, config: RetryConfig): number | null {
  const status = extractStatusCode(err)
  const networkCode = extractNetworkCode(err)

  // 429 Rate Limit — 指数退避，尊重 Retry-After
  if (status === 429) {
    const retryAfter = extractRetryAfter(err)
    if (retryAfter !== null) {
      return Math.min(retryAfter * 1000, config.maxDelayMs)
    }
    return Math.min(config.baseDelayMs * Math.pow(2, attempt), config.maxDelayMs)
  }

  // 5xx 服务端错误 — 重试 1 次
  if (status !== null && status >= 500) {
    return attempt < 1 ? config.baseDelayMs : null
  }

  // 网络错误 — 固定间隔重试
  if (networkCode !== null) {
    return config.baseDelayMs
  }

  // 其他错误（4xx 非 429）— 不重试
  return null
}

/** 生成友好的错误消息 */
export function friendlyErrorMessage(err: unknown): string {
  const status = extractStatusCode(err)
  const networkCode = extractNetworkCode(err)
  const originalMsg = err instanceof Error ? err.message : String(err)

  // 按优先级匹配提示
  const hint = (status !== null && ERROR_HINTS[String(status)])
    || (networkCode !== null && ERROR_HINTS[networkCode])
    || null

  if (hint) {
    return `${hint}\n原始错误 / Original: ${originalMsg}`
  }
  return originalMsg
}

/**
 * 包装一个产生 StreamChunk 的异步函数，在连接建立阶段自动重试。
 *
 * @param fn 创建流的工厂函数（每次重试重新调用）
 * @param providerName Provider 名称（用于日志）
 * @param config 重试配置
 */
export async function* withRetry(
  fn: () => AsyncIterable<StreamChunk>,
  providerName: string,
  config: Partial<RetryConfig> = {},
): AsyncGenerator<StreamChunk> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config }
  let lastError: unknown = null

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const stream = fn()
      // 逐 chunk yield，一旦成功消费了第一个 chunk，后续错误不再重试
      for await (const chunk of stream) {
        yield chunk
      }
      // 正常消费完毕，直接返回
      return
    } catch (err) {
      lastError = err
      const delay = getRetryDelay(err, attempt, cfg)

      if (delay === null || attempt >= cfg.maxRetries) {
        // 不可重试或已达上限，记录日志后抛出
        const friendly = friendlyErrorMessage(err)
        dbg(`[RETRY][${providerName}] 放弃重试 (attempt ${attempt + 1}/${cfg.maxRetries + 1}): ${friendly}\n`)
        // 抛出带友好消息的错误
        const finalErr = new Error(friendly)
        finalErr.cause = err
        throw finalErr
      }

      // 记录重试日志
      const status = extractStatusCode(err)
      const networkCode = extractNetworkCode(err)
      const reason = status ? `HTTP ${status}` : (networkCode ?? 'unknown')
      dbg(`[RETRY][${providerName}] ${reason}, 第 ${attempt + 1} 次重试，等待 ${delay}ms...\n`)

      await sleep(delay)
    }
  }

  // 理论上不会到这里，但作为兜底
  if (lastError) {
    const finalErr = new Error(friendlyErrorMessage(lastError))
    finalErr.cause = lastError
    throw finalErr
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

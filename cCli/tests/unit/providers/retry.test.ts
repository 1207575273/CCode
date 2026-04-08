// tests/unit/providers/retry.test.ts

import { describe, it, expect } from 'vitest'
import { withRetry, extractStatusCode, friendlyErrorMessage } from '@providers/retry.js'
import type { StreamChunk } from '@core/types.js'

/** 模拟成功的流 */
async function* successStream(): AsyncIterable<StreamChunk> {
  yield { type: 'text', text: 'hello' }
  yield { type: 'done', stopReason: 'end_turn' }
}

/** 模拟立即抛出指定错误的流工厂 */
function failFactory(err: Error, failCount: number) {
  let calls = 0
  return () => {
    calls++
    if (calls <= failCount) throw err
    return successStream()
  }
}

/** 模拟 HTTP 错误（带 status 字段） */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

/** 模拟网络错误（带 code 字段） */
function networkError(code: string): Error & { code: string } {
  const err = new Error(`connect ${code}`) as Error & { code: string }
  err.code = code
  return err
}

/** 收集流的所有 chunk */
async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('withRetry', () => {
  it('正常流直接透传，不重试', async () => {
    const chunks = await collectChunks(
      withRetry(() => successStream(), 'test'),
    )
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.type).toBe('text')
    expect(chunks[1]!.type).toBe('done')
  })

  it('429 Rate Limit — 指数退避后成功', async () => {
    const fn = failFactory(httpError(429, 'Rate limit exceeded'), 2)
    const chunks = await collectChunks(
      withRetry(fn, 'test', { baseDelayMs: 10, maxDelayMs: 100 }),
    )
    // 前 2 次失败，第 3 次成功
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.type).toBe('text')
  })

  it('429 超过最大重试次数后抛出友好错误', async () => {
    const fn = failFactory(httpError(429, 'Rate limit exceeded'), 10)
    await expect(
      collectChunks(withRetry(fn, 'test', { maxRetries: 2, baseDelayMs: 10 })),
    ).rejects.toThrow('请求频率超限')
  })

  it('5xx 重试 1 次后成功', async () => {
    const fn = failFactory(httpError(500, 'Internal server error'), 1)
    const chunks = await collectChunks(
      withRetry(fn, 'test', { baseDelayMs: 10 }),
    )
    expect(chunks).toHaveLength(2)
  })

  it('5xx 重试 1 次仍失败则抛出', async () => {
    const fn = failFactory(httpError(502, 'Bad gateway'), 5)
    await expect(
      collectChunks(withRetry(fn, 'test', { baseDelayMs: 10 })),
    ).rejects.toThrow('网关错误')
  })

  it('网络错误 ECONNREFUSED 重试后成功', async () => {
    const fn = failFactory(networkError('ECONNREFUSED'), 2)
    const chunks = await collectChunks(
      withRetry(fn, 'test', { baseDelayMs: 10 }),
    )
    expect(chunks).toHaveLength(2)
  })

  it('网络错误超过重试次数后抛出友好提示', async () => {
    const fn = failFactory(networkError('ETIMEDOUT'), 10)
    await expect(
      collectChunks(withRetry(fn, 'test', { maxRetries: 1, baseDelayMs: 10 })),
    ).rejects.toThrow('连接超时')
  })

  it('401 认证错误不重试，直接抛出', async () => {
    const fn = failFactory(httpError(401, 'Unauthorized'), 1)
    await expect(
      collectChunks(withRetry(fn, 'test', { baseDelayMs: 10 })),
    ).rejects.toThrow('认证失败')
  })

  it('404 模型不存在不重试，直接抛出', async () => {
    const fn = failFactory(httpError(404, 'Not found'), 1)
    await expect(
      collectChunks(withRetry(fn, 'test', { baseDelayMs: 10 })),
    ).rejects.toThrow('模型不存在')
  })
})

describe('extractStatusCode', () => {
  it('从 status 字段提取', () => {
    expect(extractStatusCode({ status: 429 })).toBe(429)
  })

  it('从 statusCode 字段提取', () => {
    expect(extractStatusCode({ statusCode: 500 })).toBe(500)
  })

  it('从 message 中提取', () => {
    expect(extractStatusCode(new Error('Request failed with status code 401'))).toBe(401)
  })

  it('无法提取返回 null', () => {
    expect(extractStatusCode(new Error('some random error'))).toBeNull()
  })
})

describe('friendlyErrorMessage', () => {
  it('429 返回中英双语提示', () => {
    const msg = friendlyErrorMessage(httpError(429, 'too many requests'))
    expect(msg).toContain('请求频率超限')
    expect(msg).toContain('Rate limited')
  })

  it('ECONNREFUSED 返回检查 baseURL 提示', () => {
    const msg = friendlyErrorMessage(networkError('ECONNREFUSED'))
    expect(msg).toContain('连接被拒')
    expect(msg).toContain('baseURL')
  })

  it('未知错误返回原始消息', () => {
    const msg = friendlyErrorMessage(new Error('something weird'))
    expect(msg).toBe('something weird')
  })
})

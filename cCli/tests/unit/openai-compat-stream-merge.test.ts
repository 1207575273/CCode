import { describe, it, expect, vi } from 'vitest'

/**
 * 证明 P1 优化:流式合并从「全量 reduce(concat)」改为「只合并带元数据的 chunk」后,
 * concat 调用规模从 O(chunk 总数) 降到 O(meta chunk 数)。
 *
 * 度量口径:concat 调用次数(确定性指标,不依赖墙钟,CI 稳定)。
 * 旧实现 reduce((a,b)=>a.concat(b)) 对 N 个 chunk 必然 concat N-1 次;
 * 新实现纯文本 chunk 不进合并集,1000 文本 chunk + 1 meta chunk 下 concat 应为 0。
 */

// 跨 mock 工厂共享的计数器(vi.hoisted 保证在 vi.mock 提升后仍可访问)
const h = vi.hoisted(() => ({ concatCalls: 0 }))

vi.mock('@langchain/openai', () => {
  // 纯文本增量 chunk:无 tool_calls/usage/finish_reason,新实现应判定「不进合并集」
  const textChunk = (content: string): Record<string, unknown> => ({
    content,
    tool_calls: [] as unknown[],
    concat(): Record<string, unknown> {
      h.concatCalls++
      return textChunk(content)
    },
  })
  // 末尾元数据 chunk:携带 usage_metadata + finish_reason,新实现应纳入合并集
  const metaChunk = (): Record<string, unknown> => ({
    content: '',
    tool_calls: [] as unknown[],
    usage_metadata: { input_tokens: 1234, output_tokens: 56 },
    response_metadata: { finish_reason: 'stop' },
    concat(): Record<string, unknown> {
      h.concatCalls++
      return metaChunk()
    },
  })
  return {
    ChatOpenAI: vi.fn().mockImplementation(function () {
      return {
        stream: vi.fn().mockImplementation(async function* () {
          for (let i = 0; i < 1000; i++) yield textChunk('x')
          yield metaChunk()
        }),
        getNumTokens: vi.fn().mockResolvedValue(8),
      }
    }),
  }
})

import { OpenAICompatProvider } from '@providers/openai-compat.js'
import type { ChatRequest } from '@providers/provider.js'

describe('openai-compat 流式合并性能特征', () => {
  it('1000 文本 chunk + 1 meta chunk:纯文本不进合并集,concat 调用 <= 1', async () => {
    h.concatCalls = 0
    const provider = new OpenAICompatProvider('glm', { apiKey: 'k', models: ['glm-4'] })
    const req: ChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] }

    const chunks = []
    for await (const c of provider.chat(req)) chunks.push(c)

    // 正确性:文本完整拼接、usage 正确提取、done 携带 finish_reason
    const text = chunks.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('')
    expect(text).toBe('x'.repeat(1000))
    const usage = chunks.find(c => c.type === 'usage') as { usage?: { inputTokens: number } } | undefined
    expect(usage?.usage?.inputTokens).toBe(1234)
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' })

    // 性能特征:新实现只对 1 个 meta chunk 处理 → 直接赋值不 concat → 0 次
    // (旧实现在相同输入下为 1000 次,见下方对照测试)
    expect(h.concatCalls).toBeLessThanOrEqual(1)
  })

  it('对照:旧式全量 reduce(concat) 在相同规模下合并次数 = chunk 数 - 1', () => {
    let calls = 0
    const mk = (): { content: string; concat: (o: unknown) => unknown } => ({
      content: 'x',
      concat: () => {
        calls++
        return mk()
      },
    })
    const arr = Array.from({ length: 1001 }, mk)
    arr.reduce((a: { concat: (o: unknown) => unknown }, b) => a.concat(b) as typeof a)
    // 1001 个 chunk → 1000 次 concat;新实现同输入为 0~1 次
    expect(calls).toBe(1000)
  })
})

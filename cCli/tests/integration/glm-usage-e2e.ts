/**
 * GLM Usage 端到端验证 — 模拟 openai-compat.ts 的完整流程
 *
 * 验证：从 ChatOpenAI stream → allChunks.reduce(concat) → 提取 usage_metadata
 *       → 转换为 StreamChunk { type: 'usage' } 的完整链路
 *
 * 用法：npx tsx tests/integration/glm-usage-e2e.ts
 */

import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// ── 读取配置（与 openai-compat.ts 保持一致的逻辑）──
const config = JSON.parse(readFileSync(`${homedir()}/.ccode/config.json`, 'utf8'))
const glmCfg = config.providers?.['glm-max'] ?? config.providers?.['glm']
const API_KEY = glmCfg?.apiKey
const BASE_URL = glmCfg?.baseURL || 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = process.env.GLM_MODEL || 'glm-4-flash'

if (!API_KEY) {
  console.error('❌ 缺少 GLM API Key')
  process.exit(1)
}

async function main() {
  console.log(`\n模拟 openai-compat.ts 完整流程 (model: ${MODEL})`)
  console.log('─'.repeat(50))

  // 与 openai-compat.ts #getOrCreateModel 一致
  const chatModel = new ChatOpenAI({
    apiKey: API_KEY,
    model: MODEL,
    streamUsage: true,
    ...(BASE_URL !== undefined && {
      configuration: { baseURL: BASE_URL, apiKey: API_KEY },
    }),
  })

  const messages = [new HumanMessage('你好，用一句话介绍自己')]

  // 与 openai-compat.ts chat() 一致的流处理逻辑
  const allChunks: any[] = []
  const stream = await chatModel.stream(messages)

  for await (const chunk of stream) {
    const text = typeof chunk.content === 'string' ? chunk.content : ''
    if (text) process.stdout.write(text)
    allChunks.push(chunk)
  }
  console.log('\n')

  // 与 openai-compat.ts 一致的聚合和 usage 提取
  if (allChunks.length > 0) {
    const final = allChunks.reduce((a: any, b: any) => a.concat(b))

    // 这行就是 openai-compat.ts:106 的逻辑
    const usageMeta = (final as any).usage_metadata
      ?? (final as any).response_metadata?.usage
      ?? null

    if (usageMeta) {
      const usage = {
        inputTokens: usageMeta.input_tokens ?? usageMeta.prompt_tokens ?? 0,
        outputTokens: usageMeta.output_tokens ?? usageMeta.completion_tokens ?? 0,
        cacheReadTokens: usageMeta.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usageMeta.cache_creation_input_tokens ?? 0,
      }
      console.log('✅ Usage 提取成功:')
      console.log(`   inputTokens:      ${usage.inputTokens}`)
      console.log(`   outputTokens:     ${usage.outputTokens}`)
      console.log(`   cacheReadTokens:  ${usage.cacheReadTokens}`)
      console.log(`   cacheWriteTokens: ${usage.cacheWriteTokens}`)

      // 验证 TokenMeter.consume 是否能消费
      if (usage.inputTokens > 0 && usage.outputTokens > 0) {
        console.log('\n✅ 数据完整，TokenMeter 可正确消费')
      } else {
        console.log('\n⚠ 部分字段为 0，检查字段名映射')
        console.log('   原始 usageMeta:', JSON.stringify(usageMeta, null, 2))
      }
    } else {
      console.log('❌ Usage 提取失败！usageMeta 为 null')
      console.log('   final.usage_metadata:', (final as any).usage_metadata)
      console.log('   final.response_metadata?.usage:', (final as any).response_metadata?.usage)
      console.log('   final.response_metadata:', JSON.stringify((final as any).response_metadata, null, 2))
    }
  }
}

main().catch(err => {
  console.error('执行失败:', err)
  process.exit(1)
})

/**
 * GLM 流式 token usage 诊断脚本
 *
 * 目的：验证 GLM API 在 stream 模式下是否返回 token usage 数据，
 *       以及 LangChain 的 streamUsage 选项是否生效。
 *
 * 验证环节（逐层排查）：
 *   1. streamUsage: true  — LangChain 是否发送 stream_options: { include_usage: true }
 *   2. 单 chunk 检查      — 每个 chunk 的 usage_metadata / response_metadata 是否携带数据
 *   3. concat 聚合后      — allChunks.reduce(concat) 后 usage_metadata 是否保留
 *   4. streamUsage: false — 对照组，确认差异
 *   5. invoke 对照        — 非流式模式下 usage_metadata 是否存在
 *
 * 用法：npx tsx tests/integration/glm-stream-usage.ts
 */

import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// ── 读取配置 ──
const config = JSON.parse(readFileSync(`${homedir()}/.ccode/config.json`, 'utf8'))
const glmCfg = config.providers?.['glm-max'] ?? config.providers?.['glm']
const API_KEY = process.env.GLM_API_KEY || glmCfg?.apiKey
const BASE_URL = glmCfg?.baseURL || 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = process.env.GLM_MODEL || 'glm-4-flash'

if (!API_KEY) {
  console.error('❌ 请设置 GLM_API_KEY 环境变量或在 ~/.ccode/config.json 中配置 glm/glm-max provider')
  process.exit(1)
}

const TEST_PROMPT = '你好，请用一句话介绍自己。'

// ── 工具函数 ──
function printSeparator(title: string) {
  console.log(`\n${'='.repeat(64)}`)
  console.log(`  ${title}`)
  console.log(`${'='.repeat(64)}`)
}

function printUsageFields(label: string, obj: any) {
  console.log(`\n  [${label}]`)
  console.log(`    usage_metadata:       ${JSON.stringify(obj.usage_metadata ?? null)}`)
  console.log(`    response_metadata:    ${JSON.stringify(obj.response_metadata ?? null)}`)
  // 某些模型把 usage 放在 additional_kwargs 中
  if (obj.additional_kwargs?.usage) {
    console.log(`    additional_kwargs.usage: ${JSON.stringify(obj.additional_kwargs.usage)}`)
  }
}

// ── 测试 1：streamUsage: true ──
async function testStreamWithUsage() {
  printSeparator('测试 1: stream + streamUsage: true')

  const llm = new ChatOpenAI({
    apiKey: API_KEY,
    model: MODEL,
    streamUsage: true,
    configuration: { baseURL: BASE_URL, apiKey: API_KEY },
  })

  const allChunks: any[] = []
  const stream = await llm.stream([new HumanMessage(TEST_PROMPT)])

  let chunkCount = 0
  let lastChunkWithUsage: any = null
  let textPreview = ''

  for await (const chunk of stream) {
    allChunks.push(chunk)
    chunkCount++
    const text = typeof chunk.content === 'string' ? chunk.content : ''
    textPreview += text

    // 检查每个 chunk 是否携带 usage
    const hasUsage = chunk.usage_metadata != null
      || (chunk as any).response_metadata?.usage != null
    if (hasUsage) {
      lastChunkWithUsage = chunk
      console.log(`  ✓ chunk[${chunkCount - 1}] 携带 usage 数据`)
      printUsageFields(`chunk[${chunkCount - 1}]`, chunk)
    }
  }

  console.log(`\n  总 chunk 数: ${chunkCount}`)
  console.log(`  文本预览: "${textPreview.slice(0, 80)}"`)

  if (!lastChunkWithUsage) {
    console.log(`  ⚠ 没有任何 chunk 携带 usage 数据！`)
  }

  // 聚合检查
  if (allChunks.length > 0) {
    const final = allChunks.reduce((a: any, b: any) => a.concat(b))
    printUsageFields('concat 聚合后', final)

    // 单独检查最后一个 chunk
    const lastChunk = allChunks[allChunks.length - 1]
    printUsageFields('最后一个 chunk（聚合前）', lastChunk)
  }
}

// ── 测试 2：streamUsage: false（对照组）──
async function testStreamWithoutUsage() {
  printSeparator('测试 2: stream + streamUsage: false（对照组）')

  const llm = new ChatOpenAI({
    apiKey: API_KEY,
    model: MODEL,
    streamUsage: false,
    configuration: { baseURL: BASE_URL, apiKey: API_KEY },
  })

  const allChunks: any[] = []
  const stream = await llm.stream([new HumanMessage(TEST_PROMPT)])

  let chunkCount = 0
  let anyUsageFound = false

  for await (const chunk of stream) {
    chunkCount++
    allChunks.push(chunk)
    const hasUsage = chunk.usage_metadata != null
      || (chunk as any).response_metadata?.usage != null
    if (hasUsage) {
      anyUsageFound = true
      console.log(`  ✓ chunk[${chunkCount - 1}] 携带 usage 数据（意外！对照组不该有）`)
      printUsageFields(`chunk[${chunkCount - 1}]`, chunk)
    }
  }

  console.log(`\n  总 chunk 数: ${chunkCount}`)
  console.log(`  任何 chunk 有 usage: ${anyUsageFound ? '是' : '否'}`)

  if (allChunks.length > 0) {
    const final = allChunks.reduce((a: any, b: any) => a.concat(b))
    printUsageFields('concat 聚合后', final)
  }
}

// ── 测试 3：invoke 模式（非流式）──
async function testInvoke() {
  printSeparator('测试 3: invoke 模式（非流式对照）')

  const llm = new ChatOpenAI({
    apiKey: API_KEY,
    model: MODEL,
    configuration: { baseURL: BASE_URL, apiKey: API_KEY },
  })

  const result = await llm.invoke([new HumanMessage(TEST_PROMPT)])

  console.log(`  文本: "${(typeof result.content === 'string' ? result.content : '').slice(0, 80)}"`)
  printUsageFields('invoke 结果', result)
}

// ── 测试 4：原始 HTTP 请求验证 API 层行为 ──
async function testRawHTTP() {
  printSeparator('测试 4: 原始 HTTP 请求（绕过 LangChain，直接看 API 返回）')

  // 4a: 带 stream_options
  console.log('\n  --- 4a: 带 stream_options: { include_usage: true } ---')
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    if (!res.ok) {
      const errBody = await res.text()
      console.log(`  ❌ HTTP ${res.status}: ${errBody.slice(0, 200)}`)
      console.log(`  → GLM API 可能不支持 stream_options 参数`)
    } else {
      const body = await res.text()
      const lines = body.split('\n').filter(l => l.startsWith('data: '))
      let usageFound = false

      for (const line of lines) {
        const data = line.replace('data: ', '')
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            usageFound = true
            console.log(`  ✓ 找到 usage 字段:`)
            console.log(`    ${JSON.stringify(parsed.usage)}`)
          }
        } catch { /* ignore */ }
      }

      if (!usageFound) {
        console.log(`  ⚠ 流式响应中没有 usage 字段`)
      }
      console.log(`  总 SSE 行数: ${lines.length}`)
    }
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err}`)
  }

  // 4b: 不带 stream_options
  console.log('\n  --- 4b: 不带 stream_options（看 GLM 默认行为）---')
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        stream: true,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text()
      console.log(`  ❌ HTTP ${res.status}: ${errBody.slice(0, 200)}`)
    } else {
      const body = await res.text()
      const lines = body.split('\n').filter(l => l.startsWith('data: '))
      let usageFound = false

      for (const line of lines) {
        const data = line.replace('data: ', '')
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            usageFound = true
            console.log(`  ✓ 找到 usage 字段:`)
            console.log(`    ${JSON.stringify(parsed.usage)}`)
          }
        } catch { /* ignore */ }
      }

      if (!usageFound) {
        console.log(`  ⚠ 流式响应中没有 usage 字段`)
      }
      console.log(`  总 SSE 行数: ${lines.length}`)
    }
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err}`)
  }

  // 4c: 非流式
  console.log('\n  --- 4c: 非流式请求（对照）---')
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      }),
    })

    const data = await res.json()
    if (data.usage) {
      console.log(`  ✓ 非流式 usage:`)
      console.log(`    ${JSON.stringify(data.usage)}`)
    } else {
      console.log(`  ⚠ 非流式也没有 usage 字段`)
      console.log(`    返回: ${JSON.stringify(data).slice(0, 300)}`)
    }
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err}`)
  }
}

// ── 主流程 ──
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗')
  console.log('║  GLM 流式 Token Usage 诊断                                   ║')
  console.log('╠════════════════════════════════════════════════════════════════╣')
  console.log(`║  Model:    ${MODEL.padEnd(50)}║`)
  console.log(`║  BaseURL:  ${BASE_URL.slice(0, 50).padEnd(50)}║`)
  console.log('╚════════════════════════════════════════════════════════════════╝')

  // 测试 4 最关键：先看 API 层原始行为
  await testRawHTTP()

  // 然后看 LangChain 层
  await testStreamWithUsage()
  await testStreamWithoutUsage()
  await testInvoke()

  // 结论
  printSeparator('诊断结论')
  console.log(`
  请根据以上输出判断：

  1. 如果测试 4a 返回 HTTP 错误 → GLM API 不支持 stream_options
     → 方案：用非流式 invoke 获取 usage，或在最后一个 chunk 中提取

  2. 如果测试 4a 有 usage 但测试 1 没有 → LangChain concat 聚合丢失
     → 方案：在 openai-compat.ts 中单独检查最后一个 chunk

  3. 如果测试 4b（不带 stream_options）也有 usage → GLM 默认就返回 usage
     → streamUsage 设置无影响，但要确认 LangChain 能正确解析

  4. 如果只有非流式（测试 3 / 4c）有 usage → 需要 fallback 到 invoke 获取 usage
     → 方案：在流式结束后额外发一次 token count 请求或用 invoke 结果
  `)
}

main().catch(err => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})

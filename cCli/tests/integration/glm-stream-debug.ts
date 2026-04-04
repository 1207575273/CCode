/**
 * GLM 流式 tool_calls 调试脚本 — 直接调 GLM API 验证流式返回中 tool_calls 的行为。
 *
 * 用法：npx tsx tests/integration/glm-stream-debug.ts
 *
 * 测试两种场景：
 *   1. 单轮工具调用（第一轮）
 *   2. 多轮工具调用（第二轮，带历史 tool_call + tool_result）
 *
 * 目的：确认 GLM-5.1 在流式模式下是否在某些轮次丢失 tool_calls 数据。
 */

import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages'

// 从 cCli config 读取 API key 和 baseURL
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
const config = JSON.parse(readFileSync(`${homedir()}/.ccode/config.json`, 'utf8'))
const glmMaxCfg = config.providers?.['glm-max']
const API_KEY = process.env.GLM_API_KEY || glmMaxCfg?.apiKey
const BASE_URL = glmMaxCfg?.baseURL || 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = 'glm-5.1'

if (!API_KEY) {
  console.error('请设置 GLM_API_KEY 或 ZHIPU_API_KEY 环境变量')
  process.exit(1)
}

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: '执行 Shell 命令',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'dispatch_agent',
      description: '派发子 Agent',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          prompt: { type: 'string' },
          subagent_type: { type: 'string' },
          run_in_background: { type: 'boolean' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
]

async function testRound(label: string, messages: any[], model: any) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`测试: ${label}`)
  console.log(`${'='.repeat(60)}`)

  // --- 流式模式 ---
  console.log('\n--- stream 模式 ---')
  const allChunks: any[] = []
  const stream = await model.stream(messages)
  let chunkIdx = 0
  for await (const chunk of stream) {
    const hasToolCallChunks = chunk.tool_call_chunks?.length > 0
    const hasToolCalls = chunk.tool_calls?.length > 0
    const hasAdditionalKwargs = chunk.additional_kwargs?.tool_calls?.length > 0
    const finishReason = chunk.response_metadata?.finish_reason

    if (hasToolCallChunks || hasToolCalls || hasAdditionalKwargs || finishReason) {
      console.log(`  chunk[${chunkIdx}]: tool_call_chunks=${JSON.stringify(chunk.tool_call_chunks || []).slice(0, 200)}`)
      console.log(`           tool_calls=${JSON.stringify(chunk.tool_calls || []).slice(0, 200)}`)
      console.log(`           additional_kwargs.tool_calls=${JSON.stringify(chunk.additional_kwargs?.tool_calls || []).slice(0, 200)}`)
      console.log(`           finish_reason=${finishReason || 'none'}`)
    }
    allChunks.push(chunk)
    chunkIdx++
  }

  // 聚合
  if (allChunks.length > 0) {
    const final = allChunks.reduce((a, b) => a.concat(b))
    console.log(`\n  聚合后:`)
    console.log(`    content: "${(final.content || '').slice(0, 100)}"`)
    console.log(`    tool_calls: ${JSON.stringify(final.tool_calls || []).slice(0, 300)}`)
    console.log(`    additional_kwargs.tool_calls: ${JSON.stringify(final.additional_kwargs?.tool_calls || []).slice(0, 300)}`)
    console.log(`    finish_reason: ${final.response_metadata?.finish_reason || 'none'}`)
    console.log(`    总 chunk 数: ${allChunks.length}`)
  }

  // --- invoke 模式 ---
  console.log('\n--- invoke 模式 ---')
  const invokeResult = await model.invoke(messages)
  console.log(`  content: "${(invokeResult.content || '').slice(0, 100)}"`)
  console.log(`  tool_calls: ${JSON.stringify(invokeResult.tool_calls || []).slice(0, 300)}`)
  console.log(`  additional_kwargs.tool_calls: ${JSON.stringify(invokeResult.additional_kwargs?.tool_calls || []).slice(0, 300)}`)
  console.log(`  finish_reason: ${invokeResult.response_metadata?.finish_reason || 'none'}`)

  return invokeResult
}

async function main() {
  const llm = new ChatOpenAI({
    apiKey: API_KEY,
    model: MODEL,
    configuration: { baseURL: BASE_URL, apiKey: API_KEY },
  })
  const model = llm.bindTools(tools)

  // --- 测试 1：单轮，应该返回工具调用 ---
  const result1 = await testRound(
    '第一轮：单轮工具调用',
    [new HumanMessage('在桌面创建一个项目目录，使用 bash 工具')],
    model,
  )

  // --- 测试 2：多轮，带历史的工具调用 ---
  // 模拟第一轮返回了 bash 工具调用并已执行
  const round2Messages = [
    new HumanMessage('在桌面创建前后端两个项目，使用 dispatch_agent 工具并行创建'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_round1', name: 'bash', args: { command: 'mkdir -p /tmp/test' } }],
    }),
    new ToolMessage({ content: '(no output)', tool_call_id: 'call_round1' }),
  ]

  await testRound(
    '第二轮：带历史的多工具调用（dispatch_agent）',
    round2Messages,
    model,
  )

  // --- 测试 3：直接要求 dispatch_agent（无历史）---
  await testRound(
    '第三轮：直接要求 dispatch_agent（无历史）',
    [new HumanMessage('使用 dispatch_agent 工具并行创建两个子任务：一个后端项目一个前端项目')],
    model,
  )
}

main().catch(console.error)

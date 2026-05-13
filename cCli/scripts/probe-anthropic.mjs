#!/usr/bin/env node
// 探测 Claude 官方 API 的 TTFT / TPS / Prompt Cache,用来对照 GLM 日志。
//
// 用法:
//   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/probe-anthropic.mjs
//   ANTHROPIC_API_KEY=... MODEL=claude-sonnet-4-5 node scripts/probe-anthropic.mjs
//   MODE=simple  ... node scripts/probe-anthropic.mjs    # 只跑一次,复刻 curl 样例
//   MODE=cache   ... node scripts/probe-anthropic.mjs    # 跑两次,对照 cache 写/读 TTFT(默认)

const API_KEY = "sk-W6BZSrMRy0ObTAAmok1q9v1SMk88HomeiPPpGlByXF9J3lds"
const MODEL = process.env.MODEL || 'claude-sonnet-4-5'
const MODE = process.env.MODE || 'cache'
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'

if (!API_KEY) {
  console.error('错误:请设置 ANTHROPIC_API_KEY 环境变量')
  process.exit(1)
}

// 足够长的 system prompt,触发 prompt cache(门槛约 1024 tokens,这里远超)
const LONG_SYSTEM = `You are a precise assistant for a benchmarking experiment.
Answer concisely and always follow the user's format.
${'Here is some filler context that establishes a long stable system prefix. '.repeat(120)}
Remember: answer only with the letter in parentheses when the user asks a multiple-choice question.`

async function probe(label, { useCache, system, messages, maxTokens = 32 }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    stream: true,
    messages,
    ...(system
      ? {
          system: useCache
            ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
            : system,
        }
      : {}),
  }

  const t0 = Date.now()
  let firstTokenAt = null
  let outputText = ''
  let usage = null

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`\n[${label}] HTTP ${res.status}: ${text}`)
    return null
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      const dataLine = raw.split('\n').find(l => l.startsWith('data: '))
      if (!dataLine) continue
      let ev
      try { ev = JSON.parse(dataLine.slice(6)) } catch { continue }

      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        outputText += ev.delta.text
      }
      if (ev.type === 'message_start' && ev.message?.usage) {
        usage = { ...(usage || {}), ...ev.message.usage }
      }
      if (ev.type === 'message_delta' && ev.usage) {
        usage = { ...(usage || {}), ...ev.usage }
      }
    }
  }

  const t1 = Date.now()
  const ttft = firstTokenAt ? firstTokenAt - t0 : null
  const e2e = t1 - t0
  const outputTokens = usage?.output_tokens ?? 0
  const streamSec = firstTokenAt ? (t1 - firstTokenAt) / 1000 : 0
  const tps = streamSec > 0 ? outputTokens / streamSec : 0

  console.log(`\n=== ${label} ===`)
  console.log(`  model:       ${MODEL}`)
  console.log(`  TTFT:        ${ttft}ms`)
  console.log(`  e2e:         ${e2e}ms`)
  console.log(`  output tok:  ${outputTokens}`)
  console.log(`  TPS:         ${tps.toFixed(1)} tok/s`)
  console.log(`  input tok:   ${usage?.input_tokens ?? 0}`)
  console.log(`  cache_read:  ${usage?.cache_read_input_tokens ?? 0}`)
  console.log(`  cache_write: ${usage?.cache_creation_input_tokens ?? 0}`)
  console.log(`  output text: ${JSON.stringify(outputText)}`)

  return { ttft, e2e, usage, outputTokens }
}

const messages = [
  { role: 'user', content: 'What is latin for Ant? (A) Apoidea, (B) Rhopalocera, (C) Formicidae' },
  { role: 'assistant', content: 'The answer is (' },
]

if (MODE === 'simple') {
  await probe('simple', { useCache: false, messages, maxTokens: 1 })
} else {
  // cache 模式:两次相同请求,对照 TTFT 是否因 cache 命中而降低
  const r1 = await probe('run 1 (cache write)', { useCache: true, system: LONG_SYSTEM, messages })
  const r2 = await probe('run 2 (cache read)', { useCache: true, system: LONG_SYSTEM, messages })

  if (r1 && r2) {
    const speedup = r1.ttft && r2.ttft ? (r1.ttft / r2.ttft).toFixed(2) : 'N/A'
    console.log('\n=== 对照结论 ===')
    console.log(`  TTFT  : ${r1.ttft}ms  →  ${r2.ttft}ms   (加速 ${speedup}x)`)
    console.log(`  cache : write=${r1.usage?.cache_creation_input_tokens ?? 0}  read=${r2.usage?.cache_read_input_tokens ?? 0}`)
    console.log(`  提示  : GLM 这里两次 cache 都是 0,TTFT 两次都要 20s+。Claude 若命中 cache,run2 会显著更快。`)
  }
}

#!/usr/bin/env node
// 批量验证 OpenRouter K4 + Claude 4.5+ 模型,测 TTFT / TPS / cache tokens。
// OpenRouter 走 OpenAI chat/completions 协议。
//
// 用法:
//   node scripts/probe-openrouter.mjs
//   MODELS="anthropic/claude-sonnet-4.5,anthropic/claude-sonnet-4.6" node scripts/probe-openrouter.mjs

const API_KEY = process.env.OPENROUTER_API_KEY
  || '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'

const DEFAULT_MODELS = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.7',
]

const MODELS = (process.env.MODELS ?? DEFAULT_MODELS.join(',')).split(',').map(s => s.trim()).filter(Boolean)
const BASE_URL = 'https://openrouter.ai/api/v1'

const PROMPT = [
  { role: 'user', content: 'Reply with ONLY the single letter of the correct choice, nothing else. What is latin for Ant? (A) Apoidea, (B) Rhopalocera, (C) Formicidae' },
]

async function probe(model) {
  const body = {
    model,
    max_tokens: 8,
    stream: true,
    messages: PROMPT,
  }

  const t0 = Date.now()
  let firstTokenAt = null
  let outputText = ''
  let usage = null
  let genId = null

  let res
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/ccode-cli',
        'X-Title': 'ccode-probe',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.log(`\n=== ${model} ===`)
    console.log(`  ❌ fetch 失败:`, err.message)
    return null
  }

  if (!res.ok) {
    const text = await res.text()
    console.log(`\n=== ${model} ===`)
    console.log(`  ❌ HTTP ${res.status}:`, text.slice(0, 300))
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
      const payload = dataLine.slice(6).trim()
      if (payload === '[DONE]') continue
      let ev
      try { ev = JSON.parse(payload) } catch { continue }

      if (ev.id) genId = ev.id
      const delta = ev.choices?.[0]?.delta
      if (delta?.content) {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        outputText += delta.content
      }
      if (ev.usage) usage = ev.usage
    }
  }

  const t1 = Date.now()
  const ttft = firstTokenAt ? firstTokenAt - t0 : null
  const e2e = t1 - t0
  const outputTokens = usage?.completion_tokens ?? 0
  const inputTokens = usage?.prompt_tokens ?? 0
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0
  const streamSec = firstTokenAt ? (t1 - firstTokenAt) / 1000 : 0
  const tps = streamSec > 0 ? outputTokens / streamSec : 0

  console.log(`\n=== ${model} ===`)
  console.log(`  ✅ TTFT:     ${ttft}ms`)
  console.log(`  e2e:        ${e2e}ms`)
  console.log(`  TPS:        ${tps.toFixed(1)} tok/s`)
  console.log(`  input tok:  ${inputTokens}  (cached: ${cachedTokens})`)
  console.log(`  output tok: ${outputTokens}`)
  console.log(`  output:     ${JSON.stringify(outputText)}`)
  console.log(`  genId:      ${genId}`)

  return { model, ttft, e2e, tps, inputTokens, outputTokens, cachedTokens, genId }
}

console.log(`=== OpenRouter 批量模型探测 ===`)
console.log(`  models: ${MODELS.length}`)

const results = []
for (const m of MODELS) {
  const r = await probe(m)
  if (r) results.push(r)
}

console.log(`\n=== 汇总 ===`)
console.log(`model`.padEnd(38), 'TTFT'.padStart(7), 'TPS'.padStart(8), 'in'.padStart(5), 'out'.padStart(5), 'cached'.padStart(7))
for (const r of results) {
  console.log(
    r.model.padEnd(38),
    `${r.ttft}ms`.padStart(7),
    `${r.tps.toFixed(1)}`.padStart(8),
    String(r.inputTokens).padStart(5),
    String(r.outputTokens).padStart(5),
    String(r.cachedTokens).padStart(7),
  )
}

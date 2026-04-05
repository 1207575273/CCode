/**
 * 多模态图片理解诊断脚本
 *
 * 直接测试 Provider 层的图片转换和 LLM 调用，绕开配置和门控
 * 用法：npx tsx tests/integration/vision-debug.ts
 */
import { writeImage, readImageBase64 } from '../../src/core/image-store.js'
import { OpenAICompatProvider } from '../../src/providers/openai-compat.js'
import { AnthropicProvider } from '../../src/providers/anthropic.js'
import { ProviderWrapper } from '../../src/providers/wrapper.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as https from 'node:https'
import type { Message } from '../../src/core/types.js'

// ── 工具函数 ──
function separator(title: string) {
  console.log(`\n${'═'.repeat(64)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(64)}`)
}

function fetchImageBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ccode-test' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchImageBuffer(res.headers.location).then(resolve).catch(reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function testProvider(
  label: string,
  provider: ProviderWrapper,
  model: string,
  imageId: string,
) {
  separator(`${label} / ${model}`)

  const messages: Message[] = [{
    role: 'user',
    content: [
      { type: 'text', text: '用一句话描述这张图片。' },
      { type: 'image', imageId, mediaType: 'image/jpeg' },
    ],
  }]

  try {
    let responseText = ''
    let chunkCount = 0
    const startMs = Date.now()

    for await (const chunk of provider.chat({ model, messages, maxTokens: 200 })) {
      chunkCount++
      if (chunk.type === 'text' && chunk.text) responseText += chunk.text
      if (chunk.type === 'error') {
        console.log(`  ❌ 错误: ${chunk.error}`)
        return
      }
      // 打印前几个 chunk 的类型方便诊断
      if (chunkCount <= 5) {
        const preview = JSON.stringify(chunk).slice(0, 120)
        console.log(`  chunk #${chunkCount}: ${preview}`)
      }
    }

    const durationMs = Date.now() - startMs

    if (responseText.length > 0) {
      console.log(`  ✅ 成功 (${chunkCount} chunks, ${durationMs}ms)`)
      console.log(`  响应: "${responseText.slice(0, 200)}"`)
    } else {
      console.log(`  ❌ 无文本响应 (${chunkCount} chunks, ${durationMs}ms)`)
    }
  } catch (err) {
    console.log(`  ❌ 异常: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    provider.dispose?.()
  }
}

// ── 主流程 ──
async function main() {
  console.log('🔍 多模态图片理解诊断\n')

  // Step 1: 准备测试图片
  console.log('[1] 准备测试图片...')
  let imgBuffer: Buffer
  try {
    imgBuffer = await fetchImageBuffer('https://picsum.photos/200/200')
    console.log(`    下载成功: ${imgBuffer.length} bytes`)
  } catch {
    console.log('    下载失败，使用内置图片')
    // 一个有实际内容的小 JPEG（蓝色渐变）比 1x1 像素好
    imgBuffer = Buffer.alloc(100, 0xFF)  // 回退用
  }
  const meta = writeImage(imgBuffer, 'image/jpeg')
  console.log(`    写入: ${meta.id} (${meta.sizeBytes} bytes)`)

  // 验证读取
  const readResult = readImageBase64(meta.id)
  if (!readResult) {
    console.log('    ❌ readImageBase64 返回 null！路径不一致')
    process.exit(1)
  }
  console.log(`    读取验证: base64 长度=${readResult.base64.length}`)

  // Step 2: 读取配置
  const cfg = JSON.parse(readFileSync(join(homedir(), '.ccode', 'config.json'), 'utf8'))
  const allProviders = cfg.providers as Record<string, {
    apiKey: string; baseURL?: string; protocol?: string; models: string[]; visionModels?: string[]
  }>

  // Step 3: 遍历所有有 apiKey 的 provider 测试
  for (const [name, provCfg] of Object.entries(allProviders)) {
    if (!provCfg?.apiKey) continue

    // 确定要测试的模型：优先 visionModels[0]，否则 models[0]
    const visionModel = provCfg.visionModels?.[0] ?? provCfg.models?.[0]
    if (!visionModel) continue

    const protocol = provCfg.protocol ?? (name === 'anthropic' ? 'anthropic' : 'openai')

    if (protocol === 'anthropic') {
      const raw = new AnthropicProvider(name, {
        apiKey: provCfg.apiKey,
        models: provCfg.models,
        ...(provCfg.baseURL ? { baseURL: provCfg.baseURL } : {}),
      })
      await testProvider(`Anthropic [${name}]`, new ProviderWrapper(raw), visionModel, meta.id)
    } else {
      const raw = new OpenAICompatProvider(name, {
        apiKey: provCfg.apiKey,
        models: provCfg.models,
        ...(provCfg.baseURL ? { baseURL: provCfg.baseURL } : {}),
      })
      await testProvider(`OpenAI [${name}]`, new ProviderWrapper(raw), visionModel, meta.id)
    }
  }

  separator('诊断完成')
}

main().catch(err => {
  console.error('❌ 未捕获异常:', err)
  process.exit(1)
})

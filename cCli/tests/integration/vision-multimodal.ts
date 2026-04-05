/**
 * 多模态图片理解集成测试
 *
 * 验证完整链路：图片写入 → readImageBase64 → Provider 格式转换 → LLM API 调用 → 获得描述
 *
 * 测试场景：
 *   1. ImageStore 读写一致性：写入 → 读取 base64 → 验证非空
 *   2. OpenAI 兼容 Provider（LangChain）：发送图片 → 模型返回描述文本
 *   3. Anthropic Provider：发送图片 → 模型返回描述文本
 *
 * 用法：
 *   npx tsx tests/integration/vision-multimodal.ts                     # 测试所有可用 provider
 *   npx tsx tests/integration/vision-multimodal.ts --provider=glm      # 指定 provider
 *   npx tsx tests/integration/vision-multimodal.ts --provider=anthropic # 指定 anthropic
 *
 * 前置条件：
 *   - ~/.ccode/config.json 中至少配置了一个 provider 的 apiKey
 *   - 对应 provider 的 visionModels 中有支持图片的模型
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeImage, readImageBase64 } from '../../src/core/image-store.js'
import { OpenAICompatProvider } from '../../src/providers/openai-compat.js'
import { AnthropicProvider } from '../../src/providers/anthropic.js'
import { ProviderWrapper } from '../../src/providers/wrapper.js'
import type { Message } from '../../src/core/types.js'

// ── 读取配置 ──
const configPath = join(homedir(), '.ccode', 'config.json')
let config: Record<string, unknown>
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch {
  console.error('❌ 无法读取 ~/.ccode/config.json')
  process.exit(1)
}

const providers = (config['providers'] ?? {}) as Record<string, {
  apiKey: string
  baseURL?: string
  protocol?: string
  models: string[]
  visionModels?: string[]
}>

// ── 解析命令行参数 ──
const args = process.argv.slice(2)
const providerArg = args.find(a => a.startsWith('--provider='))?.split('=')[1]

// ── 工具函数 ──
function separator(title: string) {
  console.log(`\n${'═'.repeat(64)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(64)}`)
}

function pass(msg: string) { console.log(`  ✅ ${msg}`) }
function fail(msg: string) { console.log(`  ❌ ${msg}`) }
function info(msg: string) { console.log(`  ℹ  ${msg}`) }

// ── 生成一张简单的测试图片（1x1 红色像素 JPEG） ──
// 这是一个最小的合法 JPEG 文件（红色像素），用于测试链路而非复杂图片理解
const MINIMAL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH' +
  'BwYIDAoMCwsKCwsNCwwMDQoQDA4PDQ4MExEUEBMRFBwSFBQSFBwRERH/2wBDAQME' +
  'BAUEBQkFBQkRCwsLERERERERERERERERERERERERERERERERERERERERERERERER' +
  'EREREREREREREREREREREREREREREREREREREP/wAARCAABAAEDASIAAhEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/' +
  'EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEB' +
  'AAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=',
  'base64'
)

// ── 测试 1：ImageStore 读写一致性 ──
async function testImageStore() {
  separator('测试 1: ImageStore 读写一致性')

  try {
    const meta = writeImage(MINIMAL_JPEG, 'image/jpeg')
    info(`写入成功: id=${meta.id}, file=${meta.fileName}, size=${meta.sizeBytes}B`)

    const data = readImageBase64(meta.id)
    if (!data) {
      fail('readImageBase64 返回 null，文件写入后无法读取')
      return null
    }

    if (data.mediaType !== 'image/jpeg') {
      fail(`mediaType 不匹配: expected image/jpeg, got ${data.mediaType}`)
      return null
    }

    if (data.base64.length === 0) {
      fail('base64 为空')
      return null
    }

    pass(`读取成功: base64 长度=${data.base64.length}, mediaType=${data.mediaType}`)
    return meta.id
  } catch (err) {
    fail(`异常: ${err}`)
    return null
  }
}

// ── 测试 2：OpenAI 兼容 Provider 图片理解 ──
async function testOpenAICompat(providerName: string, cfg: typeof providers[string], imageId: string) {
  const visionModel = cfg.visionModels?.[0]
  if (!visionModel) {
    info(`${providerName} 无 visionModels 配置，跳过`)
    return
  }

  separator(`测试 2: OpenAI 兼容 Provider [${providerName}] / ${visionModel}`)

  const raw = new OpenAICompatProvider(providerName, {
    apiKey: cfg.apiKey,
    models: cfg.models,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  })
  const provider = new ProviderWrapper(raw)

  const messages: Message[] = [{
    role: 'user',
    content: [
      { type: 'text', text: '用一句话描述这张图片的内容。' },
      { type: 'image', imageId, mediaType: 'image/jpeg' },
    ],
  }]

  try {
    let responseText = ''
    const startMs = Date.now()

    for await (const chunk of provider.chat({
      model: visionModel,
      messages,
      maxTokens: 100,
    })) {
      if (chunk.type === 'text' && chunk.text) {
        responseText += chunk.text
      }
      if (chunk.type === 'error') {
        fail(`流错误: ${chunk.error}`)
        return
      }
    }

    const durationMs = Date.now() - startMs

    if (responseText.length > 0) {
      pass(`模型返回文本 (${durationMs}ms): "${responseText.slice(0, 100)}..."`)
    } else {
      fail(`模型未返回任何文本 (${durationMs}ms)`)
    }
  } catch (err) {
    fail(`调用异常: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    provider.dispose?.()
  }
}

// ── 测试 3：Anthropic Provider 图片理解 ──
async function testAnthropic(providerName: string, cfg: typeof providers[string], imageId: string) {
  const visionModel = cfg.visionModels?.[0]
  if (!visionModel) {
    info(`${providerName} 无 visionModels 配置，跳过`)
    return
  }

  separator(`测试 3: Anthropic Provider [${providerName}] / ${visionModel}`)

  const raw = new AnthropicProvider(providerName, {
    apiKey: cfg.apiKey,
    models: cfg.models,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  })
  const provider = new ProviderWrapper(raw)

  const messages: Message[] = [{
    role: 'user',
    content: [
      { type: 'text', text: '用一句话描述这张图片的内容。' },
      { type: 'image', imageId, mediaType: 'image/jpeg' },
    ],
  }]

  try {
    let responseText = ''
    const startMs = Date.now()

    for await (const chunk of provider.chat({
      model: visionModel,
      messages,
      maxTokens: 100,
    })) {
      if (chunk.type === 'text' && chunk.text) {
        responseText += chunk.text
      }
      if (chunk.type === 'error') {
        fail(`流错误: ${chunk.error}`)
        return
      }
    }

    const durationMs = Date.now() - startMs

    if (responseText.length > 0) {
      pass(`模型返回文本 (${durationMs}ms): "${responseText.slice(0, 100)}..."`)
    } else {
      fail(`模型未返回任何文本 (${durationMs}ms)`)
    }
  } catch (err) {
    fail(`调用异常: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    provider.dispose?.()
  }
}

// ── 主流程 ──
async function main() {
  console.log('🔍 多模态图片理解集成测试\n')

  // Step 1: 写入测试图片
  const imageId = await testImageStore()
  if (!imageId) {
    console.log('\n⛔ ImageStore 测试失败，后续测试跳过')
    process.exit(1)
  }

  // Step 2: 遍历 provider 测试
  const targetProviders = providerArg
    ? Object.entries(providers).filter(([name]) => name === providerArg)
    : Object.entries(providers)

  if (targetProviders.length === 0) {
    console.log(`\n⚠ 未找到 provider${providerArg ? ` "${providerArg}"` : ''}`)
    process.exit(1)
  }

  for (const [name, cfg] of targetProviders) {
    if (!cfg.apiKey) {
      info(`${name}: 无 apiKey，跳过`)
      continue
    }
    if (!cfg.visionModels?.length) {
      info(`${name}: 无 visionModels 配置，跳过`)
      continue
    }

    const protocol = cfg.protocol ?? (name === 'anthropic' ? 'anthropic' : 'openai')

    if (protocol === 'anthropic') {
      await testAnthropic(name, cfg, imageId)
    } else {
      await testOpenAICompat(name, cfg, imageId)
    }
  }

  separator('测试完成')
}

main().catch(err => {
  console.error('❌ 未捕获异常:', err)
  process.exit(1)
})

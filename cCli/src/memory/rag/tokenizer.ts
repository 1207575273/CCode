// src/memory/rag/tokenizer.ts

/**
 * 可插拔分词器 — BM25 倒排索引的基础。
 *
 * MVP 默认 jieba-wasm（中文精准分词），CJK Bigram 作为降级兜底。
 * 设计文档：§3.6 中文分词
 */

import type { Tokenizer } from '@memory/types.js'

// ═══════════════════════════════════════════════
// CJK 字符范围检测
// ═══════════════════════════════════════════════

/** 判断字符是否为 CJK 统一表意文字 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0)
  if (code === undefined) return false
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 基本区
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK 扩展 A
    (code >= 0x20000 && code <= 0x2a6df) || // CJK 扩展 B
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK 兼容
    (code >= 0x2f800 && code <= 0x2fa1f)    // CJK 兼容补充
  )
}

/** 将文本按 CJK / 非 CJK 分段 */
interface TextSegment {
  text: string
  isCJK: boolean
}

function splitByScript(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let current = ''
  let currentIsCJK = false

  for (const char of text) {
    const charIsCJK = isCJK(char)
    if (current.length > 0 && charIsCJK !== currentIsCJK) {
      segments.push({ text: current, isCJK: currentIsCJK })
      current = ''
    }
    current += char
    currentIsCJK = charIsCJK
  }

  if (current.length > 0) {
    segments.push({ text: current, isCJK: currentIsCJK })
  }

  return segments
}

// ═══════════════════════════════════════════════
// 停用词
// ═══════════════════════════════════════════════

const STOP_WORDS = new Set([
  '的', '了', '和', '是', '在', '有', '我', '这', '个', '就',
  '不', '也', '都', '一', '你', '他', '她', '它', '们', '要',
  '会', '对', '说', '而', '但', '被', '到', '从', '把', '那',
  '很', '让', '又', '才', '只', '为', '以', '与', '及', '或',
  '如', '则', '等', '所', '之', '于', '其', '可', '能', '中',
  // 英文停用词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'and', 'but', 'or', 'not', 'no', 'nor',
  'so', 'if', 'then', 'than', 'too', 'very', 'just', 'about',
  'it', 'its', 'this', 'that', 'these', 'those',
])

// ═══════════════════════════════════════════════
// Jieba 分词器（MVP 默认）
// ═══════════════════════════════════════════════

export class JiebaTokenizer implements Tokenizer {
  private jieba: { cut: (text: string, hmm?: boolean) => string[] } | null = null
  private initPromise: Promise<void> | null = null
  private initialized = false

  /** 懒加载 jieba-wasm（异步，ESM 兼容） */
  async ensureInit(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    try {
      const mod = await import('jieba-wasm') as Record<string, unknown>
      // jieba-wasm 导出 cut 在顶层或 default 上
      const cut = typeof mod.cut === 'function'
        ? mod.cut as (text: string, hmm?: boolean) => string[]
        : (mod.default as { cut?: (text: string, hmm?: boolean) => string[] })?.cut ?? null
      if (cut) {
        this.jieba = { cut }
      }
    } catch {
      // jieba-wasm 加载失败，tokenize 时走降级
    } finally {
      this.initialized = true
    }
  }

  tokenize(text: string): string[] {
    if (!this.jieba) {
      // 降级为 Bigram
      return BIGRAM_TOKENIZER.tokenize(text)
    }

    const words = this.jieba.cut(text, true)
    const tokens: string[] = []
    for (const w of words) {
      const trimmed = w.trim()
      if (trimmed.length === 0) continue
      if (STOP_WORDS.has(trimmed)) continue
      // 英文小写化
      tokens.push(/^[\x00-\x7f]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed)
    }
    return tokens
  }

  /** jieba-wasm 是否可用（必须先 await ensureInit） */
  isAvailable(): boolean {
    return this.jieba !== null
  }
}

// ═══════════════════════════════════════════════
// CJK Bigram 分词器（降级兜底）
// ═══════════════════════════════════════════════

export class BigramTokenizer implements Tokenizer {
  tokenize(text: string): string[] {
    const tokens: string[] = []
    for (const segment of splitByScript(text)) {
      if (segment.isCJK) {
        const chars = [...segment.text]
        for (let i = 0; i < chars.length; i++) {
          const char = chars[i]!
          if (STOP_WORDS.has(char)) continue
          tokens.push(char) // unigram
          if (i + 1 < chars.length) {
            tokens.push(char + chars[i + 1]!) // bigram
          }
        }
      } else {
        // 非 CJK：按空格 + 标点分词
        const words = segment.text.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean)
        for (const w of words) {
          if (w.length > 0 && !STOP_WORDS.has(w)) {
            tokens.push(w)
          }
        }
      }
    }
    return tokens
  }
}

// ═══════════════════════════════════════════════
// 单例 & 工厂
// ═══════════════════════════════════════════════

const BIGRAM_TOKENIZER = new BigramTokenizer()

/** 全局分词器实例（懒加载单例） */
let _tokenizer: Tokenizer | null = null
let _initPromise: Promise<Tokenizer> | null = null

/**
 * 获取分词器实例（异步）。
 * 优先 jieba-wasm，不可用时降级为 CJK Bigram。
 */
export async function getTokenizer(): Promise<Tokenizer> {
  if (_tokenizer) return _tokenizer
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    const jieba = new JiebaTokenizer()
    await jieba.ensureInit()
    if (jieba.isAvailable()) {
      _tokenizer = jieba
    } else {
      console.warn('[Memory] jieba-wasm 未安装或加载失败，BM25 降级为 CJK Bigram（中文检索精度下降）')
      _tokenizer = BIGRAM_TOKENIZER
    }
    return _tokenizer
  })()
  return _initPromise
}

/** 导出工具函数供测试使用 */
export { splitByScript, isCJK, STOP_WORDS }

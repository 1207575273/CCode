import { describe, it, expect, beforeAll } from 'vitest'
import { JiebaTokenizer, BigramTokenizer, getTokenizer, isCJK, splitByScript, STOP_WORDS } from '@memory/rag/tokenizer.js'

describe('isCJK', () => {
  it('识别常见中文字符', () => {
    expect(isCJK('中')).toBe(true)
    expect(isCJK('件')).toBe(true)
    expect(isCJK('龍')).toBe(true)
  })

  it('排除英文和数字', () => {
    expect(isCJK('a')).toBe(false)
    expect(isCJK('Z')).toBe(false)
    expect(isCJK('1')).toBe(false)
    expect(isCJK(' ')).toBe(false)
  })
})

describe('splitByScript', () => {
  it('中英文混合文本正确分段', () => {
    const segments = splitByScript('认证middleware重写')
    expect(segments.length).toBe(3)
    expect(segments[0]).toEqual({ text: '认证', isCJK: true })
    expect(segments[1]).toEqual({ text: 'middleware', isCJK: false })
    expect(segments[2]).toEqual({ text: '重写', isCJK: true })
  })

  it('纯中文返回单段', () => {
    const segments = splitByScript('认证中间件')
    expect(segments.length).toBe(1)
    expect(segments[0]!.isCJK).toBe(true)
  })

  it('纯英文返回单段', () => {
    const segments = splitByScript('hello world')
    expect(segments.length).toBe(1)
    expect(segments[0]!.isCJK).toBe(false)
  })
})

describe('BigramTokenizer', () => {
  const tokenizer = new BigramTokenizer()

  it('中文生成 unigram + bigram', () => {
    const tokens = tokenizer.tokenize('算法')
    expect(tokens).toContain('算')
    expect(tokens).toContain('法')
    expect(tokens).toContain('算法')
  })

  it('过滤中文停用词', () => {
    const tokens = tokenizer.tokenize('的了是')
    // "的""了""是"都在停用词中
    expect(tokens.every(t => !STOP_WORDS.has(t))).toBe(true)
  })

  it('英文空格分词并小写化', () => {
    const tokens = tokenizer.tokenize('Hello World')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
  })

  it('中英混合', () => {
    const tokens = tokenizer.tokenize('认证middleware')
    expect(tokens).toContain('认')
    expect(tokens).toContain('证')
    expect(tokens).toContain('认证')
    expect(tokens).toContain('middleware')
  })

  it('空字符串返回空数组', () => {
    expect(tokenizer.tokenize('')).toEqual([])
  })
})

describe('JiebaTokenizer', () => {
  const tokenizer = new JiebaTokenizer()

  beforeAll(async () => {
    await tokenizer.ensureInit()
  })

  it('jieba-wasm 可用', () => {
    expect(tokenizer.isAvailable()).toBe(true)
  })

  it('中文精准分词', () => {
    const tokens = tokenizer.tokenize('认证中间件重写')
    // jieba 应该切出有意义的词，不应该有 "证中" 这样的噪音
    expect(tokens).toContain('认证')
    expect(tokens).toContain('中间件')
    expect(tokens).toContain('重写')
    expect(tokens).not.toContain('证中')
  })

  it('过滤停用词', () => {
    const tokens = tokenizer.tokenize('这是一个认证中间件的重写')
    expect(tokens).not.toContain('这')
    expect(tokens).not.toContain('是')
    expect(tokens).not.toContain('一')
    expect(tokens).not.toContain('个')
    expect(tokens).not.toContain('的')
  })

  it('英文小写化', () => {
    const tokens = tokenizer.tokenize('Hello World test')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
    expect(tokens).toContain('test')
  })

  it('中英混合', () => {
    const tokens = tokenizer.tokenize('使用React组件')
    expect(tokens).toContain('react')
    // 应该包含"使用"和"组件"
    expect(tokens.some(t => t.includes('使用'))).toBe(true)
    expect(tokens.some(t => t.includes('组件'))).toBe(true)
  })
})

describe('getTokenizer', () => {
  it('返回分词器实例', async () => {
    const t = await getTokenizer()
    expect(t).toBeDefined()
    expect(typeof t.tokenize).toBe('function')
  })

  it('分词结果非空', async () => {
    const t = await getTokenizer()
    const tokens = t.tokenize('记忆系统设计')
    expect(tokens.length).toBeGreaterThan(0)
  })
})

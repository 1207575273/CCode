import { describe, it, expect } from 'vitest'
import { RecursiveCharacterChunker } from '@memory/rag/chunker.js'

describe('RecursiveCharacterChunker', () => {
  const chunker = new RecursiveCharacterChunker({ maxChunkSize: 200, overlap: 20 })

  it('小文本不切分', () => {
    const chunks = chunker.chunkText('这是一段短文本')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('这是一段短文本')
  })

  it('空文本返回空数组', () => {
    expect(chunker.chunkText('')).toEqual([])
    expect(chunker.chunkText('   ')).toEqual([])
  })

  it('按标题分隔符切分', () => {
    const content1 = '内容一'.repeat(40) // 120 字符
    const content2 = '内容二'.repeat(40)
    const text = `# 标题一\n\n${content1}\n\n## 标题二\n\n${content2}`
    const chunks = chunker.chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('按段落分隔符切分', () => {
    const para1 = '段落一'.repeat(40) // 120 字符
    const para2 = '段落二'.repeat(40)
    const text = para1 + '\n\n' + para2
    const chunks = chunker.chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('超大段落强制按字符数切割', () => {
    const text = '重复'.repeat(200) // 400字符，超过200
    const chunks = chunker.chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(220) // maxChunkSize + 一些余量
    }
  })

  it('chunkEntry 生成带 ID 的 chunk 列表', () => {
    const text = '段落一'.repeat(40) + '\n\n' + '段落二'.repeat(40)
    const chunks = chunker.chunkEntry('test-entry', text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.id).toBe('test-entry_0')
    expect(chunks[0]!.entryId).toBe('test-entry')
    expect(chunks[0]!.chunkIndex).toBe(0)
    if (chunks.length > 1) {
      expect(chunks[1]!.id).toBe('test-entry_1')
      expect(chunks[1]!.chunkIndex).toBe(1)
    }
  })

  it('默认参数（2000 字符）正常工作', () => {
    const defaultChunker = new RecursiveCharacterChunker()
    const shortText = '短文本测试'
    expect(defaultChunker.chunkText(shortText)).toHaveLength(1)
  })
})

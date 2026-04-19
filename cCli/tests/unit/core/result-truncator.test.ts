import { describe, it, expect } from 'vitest'
import {
  SUMMARY_MAX_CHARS,
  FULL_MAX_CHARS,
  LLM_MAX_CHARS,
  truncate,
  truncateForSummary,
  truncateForFull,
  truncateForLLM,
} from '@core/result-truncator.js'

describe('result-truncator', () => {
  describe('常量', () => {
    it('SUMMARY_MAX_CHARS = 200', () => {
      expect(SUMMARY_MAX_CHARS).toBe(200)
    })
    it('FULL_MAX_CHARS = 100_000', () => {
      expect(FULL_MAX_CHARS).toBe(100_000)
    })
    it('LLM_MAX_CHARS = 40_000', () => {
      expect(LLM_MAX_CHARS).toBe(40_000)
    })
  })

  describe('truncate — 通用 helper', () => {
    it('文本短于 maxLength 时原样返回', () => {
      expect(truncate('hello', 10)).toBe('hello')
    })

    it('文本恰好等于 maxLength 时原样返回', () => {
      expect(truncate('hello', 5)).toBe('hello')
    })

    it('短阈值(< 10000)超出时追加 "..."', () => {
      expect(truncate('hellohello', 5)).toBe('hello...')
    })

    it('长阈值(>= 10000)超出时追加原长度信息', () => {
      const text = 'x'.repeat(15_000)
      const result = truncate(text, 10_000)
      expect(result.startsWith('x'.repeat(10_000))).toBe(true)
      expect(result).toContain('(truncated, total 15000 chars)')
    })
  })

  describe('truncateForSummary — 200 字符上限', () => {
    it('短于 200 字符原样返回', () => {
      const text = 'short text'
      expect(truncateForSummary(text)).toBe(text)
    })

    it('超过 200 字符截断附 "..."', () => {
      const text = 'a'.repeat(300)
      const result = truncateForSummary(text)
      expect(result).toBe('a'.repeat(200) + '...')
    })
  })

  describe('truncateForFull — 100K 字符上限', () => {
    it('短于 100K 字符原样返回', () => {
      const text = 'x'.repeat(50_000)
      expect(truncateForFull(text)).toBe(text)
    })

    it('超过 100K 字符截断附长度信息', () => {
      const text = 'x'.repeat(150_000)
      const result = truncateForFull(text)
      expect(result.startsWith('x'.repeat(100_000))).toBe(true)
      expect(result).toContain('(truncated, total 150000 chars)')
    })
  })

  describe('truncateForLLM — 40K + 工具专属 hint', () => {
    it('短于 40K 字符原样返回(任意工具)', () => {
      const text = 'x'.repeat(20_000)
      expect(truncateForLLM(text, 'bash')).toBe(text)
    })

    it('bash 工具超长带专属引导', () => {
      const text = 'x'.repeat(50_000)
      const result = truncateForLLM(text, 'bash')
      expect(result.startsWith('x'.repeat(40_000))).toBe(true)
      expect(result).toContain('结果已截断')
      expect(result).toContain('grep/head/tail 过滤输出')
    })

    it('grep 工具超长带专属引导', () => {
      const text = 'x'.repeat(50_000)
      const result = truncateForLLM(text, 'grep')
      expect(result).toContain('缩小 pattern 范围')
    })

    it('read_file 工具超长带专属引导', () => {
      const text = 'x'.repeat(50_000)
      const result = truncateForLLM(text, 'read_file')
      expect(result).toContain('指定行号范围')
    })

    it('task_output 工具超长带专属引导', () => {
      const text = 'x'.repeat(50_000)
      const result = truncateForLLM(text, 'task_output')
      expect(result).toContain('grep/tail 过滤关键信息')
    })

    it('未知工具超长回退到通用 hint', () => {
      const text = 'x'.repeat(50_000)
      const result = truncateForLLM(text, 'some_mcp_tool')
      expect(result).toContain('结果过长已截断')
      expect(result).toContain('缩小查询范围')
    })

    it('截断信息包含原文长度', () => {
      const text = 'x'.repeat(45_123)
      const result = truncateForLLM(text, 'bash')
      expect(result).toContain('共 45123 字符')
      expect(result).toContain('仅保留前 40000 字符')
    })
  })
})

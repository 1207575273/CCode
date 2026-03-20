import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { computeEditDiff, computeWriteDiff } from '@utils/compute-diff'

const TMP_DIR = join(import.meta.dirname, '../../.tmp-diff-test')

function tmpFile(name: string): string {
  return join(TMP_DIR, name)
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
})

describe('computeEditDiff', () => {
  it('should produce hunks when replacing string in a real temp file', () => {
    const filePath = tmpFile('edit-basic.txt')
    const original = 'line1\nline2\nline3\nline4\n'
    writeFileSync(filePath, original, 'utf-8')

    const result = computeEditDiff(filePath, 'line2', 'modified')

    expect(result.filePath).toBe(filePath)
    expect(result.isNewFile).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.hunks.length).toBeGreaterThan(0)
    expect(result.deletions).toBeGreaterThan(0)
    expect(result.additions).toBeGreaterThan(0)

    // 验证 hunk 内容包含被替换的行
    const allLines = result.hunks.flatMap(h => h.lines)
    const hasRemoval = allLines.some(l => l.startsWith('-') && l.includes('line2'))
    const hasAddition = allLines.some(l => l.startsWith('+') && l.includes('modified'))
    expect(hasRemoval).toBe(true)
    expect(hasAddition).toBe(true)
  })

  it('should return error when file not found', () => {
    const filePath = tmpFile('nonexistent.txt')

    const result = computeEditDiff(filePath, 'old', 'new')

    expect(result.filePath).toBe(filePath)
    expect(result.error).toBeDefined()
    expect(result.hunks).toHaveLength(0)
    expect(result.additions).toBe(0)
    expect(result.deletions).toBe(0)
  })
})

describe('computeWriteDiff', () => {
  it('should show full add when file is new (does not exist)', () => {
    const filePath = tmpFile('new-file.txt')
    const content = 'hello\nworld\n'

    const result = computeWriteDiff(filePath, content)

    expect(result.filePath).toBe(filePath)
    expect(result.isNewFile).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.hunks.length).toBeGreaterThan(0)
    expect(result.additions).toBeGreaterThan(0)
    expect(result.deletions).toBe(0)
  })

  it('should show diff when overwriting existing file', () => {
    const filePath = tmpFile('overwrite.txt')
    writeFileSync(filePath, 'old content\n', 'utf-8')

    const result = computeWriteDiff(filePath, 'new content\n')

    expect(result.filePath).toBe(filePath)
    expect(result.isNewFile).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.hunks.length).toBeGreaterThan(0)
    expect(result.additions).toBeGreaterThan(0)
    expect(result.deletions).toBeGreaterThan(0)
  })

  it('should truncate new file over 20 lines and set truncatedLines', () => {
    const filePath = tmpFile('long-new-file.txt')
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n') + '\n'

    const result = computeWriteDiff(filePath, content)

    expect(result.filePath).toBe(filePath)
    expect(result.isNewFile).toBe(true)
    expect(result.truncatedLines).toBe(10) // 30 - 20 = 10 lines truncated
    // hunks 应该只包含截断后的内容（20 行）
    const addedLines = result.hunks.flatMap(h => h.lines).filter(l => l.startsWith('+'))
    expect(addedLines.length).toBeLessThanOrEqual(20)
  })
})

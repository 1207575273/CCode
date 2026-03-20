import { describe, it, expect } from 'vitest'
import { formatDuration, truncate } from '@ui/format-utils.js'

describe('formatDuration', () => {
  it('should return "0ms" for 0 milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms')
  })

  it('should return "500ms" for 500 milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('should return "999ms" for 999 milliseconds', () => {
    expect(formatDuration(999)).toBe('999ms')
  })

  it('should return "1.0s" for 1000 milliseconds', () => {
    expect(formatDuration(1000)).toBe('1.0s')
  })

  it('should return "3.2s" for 3200 milliseconds', () => {
    expect(formatDuration(3200)).toBe('3.2s')
  })

  it('should return "60.0s" for 59999 milliseconds', () => {
    expect(formatDuration(59999)).toBe('60.0s')
  })

  it('should return "1m" for exactly 60000 milliseconds', () => {
    expect(formatDuration(60000)).toBe('1m')
  })

  it('should return "1m 3s" for 63000 milliseconds', () => {
    expect(formatDuration(63000)).toBe('1m 3s')
  })

  it('should return "2m 5s" for 125000 milliseconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s')
  })
})

describe('truncate', () => {
  it('should not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('should not truncate strings exactly at maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('should truncate strings exceeding maxLen and append ...', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
  })
})

// tests/unit/useStatusBar.test.ts
import { describe, it, expect } from 'vitest'
import { THRESHOLD_WARNING, THRESHOLD_CRITICAL, BAR_WIDTH, sampleCpuTimes } from '../../src/ui/useStatusBar.js'

describe('useStatusBar 常量', () => {
  it('色阶阈值合理', () => {
    expect(THRESHOLD_WARNING).toBe(60)
    expect(THRESHOLD_CRITICAL).toBe(85)
    expect(THRESHOLD_WARNING).toBeLessThan(THRESHOLD_CRITICAL)
  })

  it('进度条宽度为 10', () => {
    expect(BAR_WIDTH).toBe(10)
  })
})

describe('sampleCpuTimes', () => {
  it('返回 idle 和 total，total >= idle >= 0', () => {
    const result = sampleCpuTimes()
    expect(result.total).toBeGreaterThan(0)
    expect(result.idle).toBeGreaterThanOrEqual(0)
    expect(result.total).toBeGreaterThanOrEqual(result.idle)
  })
})

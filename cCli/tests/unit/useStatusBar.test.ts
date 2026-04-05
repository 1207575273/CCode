// tests/unit/useStatusBar.test.ts
import { describe, it, expect } from 'vitest'
import { THRESHOLD_WARNING, THRESHOLD_CRITICAL, BAR_WIDTH } from '../../src/ui/useStatusBar.js'

describe('useStatusBar 常量', () => {
  it('色阶阈值合理', () => {
    expect(THRESHOLD_WARNING).toBe(60)
    expect(THRESHOLD_CRITICAL).toBe(85)
    expect(THRESHOLD_WARNING).toBeLessThan(THRESHOLD_CRITICAL)
  })

  it('进度条默认宽度在范围内', () => {
    expect(BAR_WIDTH).toBeGreaterThanOrEqual(4)
    expect(BAR_WIDTH).toBeLessThanOrEqual(16)
  })
})

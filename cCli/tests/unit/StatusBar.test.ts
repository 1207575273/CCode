// tests/unit/StatusBar.test.ts
import { describe, it, expect } from 'vitest'
import { renderBar, barColor, formatBytes, formatElapsed, formatTokenCount } from '../../src/ui/StatusBar.js'

describe('renderBar', () => {
  it('0% 全空', () => {
    expect(renderBar(0, 10)).toBe('░░░░░░░░░░')
  })

  it('100% 全满', () => {
    expect(renderBar(100, 10)).toBe('██████████')
  })

  it('50% 半满', () => {
    expect(renderBar(50, 10)).toBe('█████░░░░░')
  })
})

describe('barColor', () => {
  it('低于 60% 绿色', () => {
    expect(barColor(30)).toBe('green')
    expect(barColor(59)).toBe('green')
  })

  it('60-85% 黄色', () => {
    expect(barColor(60)).toBe('yellow')
    expect(barColor(84)).toBe('yellow')
  })

  it('85%+ 红色', () => {
    expect(barColor(85)).toBe('red')
    expect(barColor(100)).toBe('red')
  })
})

describe('formatBytes', () => {
  it('MB 范围', () => {
    expect(formatBytes(256 * 1024 * 1024)).toBe('256MB')
  })

  it('GB 范围', () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5GB')
  })
})

describe('formatElapsed', () => {
  it('不足 1 小时显示 MM:SS', () => {
    expect(formatElapsed(65_000)).toBe('01:05')
  })

  it('超过 1 小时显示 HH:MM:SS', () => {
    expect(formatElapsed(3661_000)).toBe('01:01:01')
  })

  it('0 毫秒', () => {
    expect(formatElapsed(0)).toBe('00:00')
  })
})

describe('formatTokenCount', () => {
  it('小于 1000 原样输出', () => {
    expect(formatTokenCount(500)).toBe('500')
  })

  it('K 缩写', () => {
    expect(formatTokenCount(1500)).toBe('1.5K')
  })

  it('M 缩写', () => {
    expect(formatTokenCount(2_500_000)).toBe('2.5M')
  })
})

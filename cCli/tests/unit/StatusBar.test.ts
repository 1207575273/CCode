// tests/unit/StatusBar.test.ts
import { describe, it, expect } from 'vitest'
import { renderBar, barColor, formatBytes, formatElapsed, formatTokenCount, formatInboundCaller, formatInboundLabel } from '../../src/ui/StatusBar.js'
import type { InboundActivity } from '../../src/a2a/node-status.js'

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

describe('formatInboundCaller', () => {
  it('有项目名时显示项目名', () => {
    expect(formatInboundCaller({ projectName: 'web', port: 54751 })).toBe('web')
  })

  it('仅端口时显示端口', () => {
    expect(formatInboundCaller({ port: 54751 })).toBe(':54751')
  })

  it('无 caller 时显示远程', () => {
    expect(formatInboundCaller(undefined)).toBe('远程')
  })
})

describe('formatInboundLabel', () => {
  const NOW = 1000_000

  it('无活动返回 null', () => {
    const activity: InboundActivity = { active: 0, recent: [] }
    expect(formatInboundLabel(activity, NOW)).toBeNull()
  })

  it('单个执行中显示来源 + 执行中（cyan）', () => {
    const activity: InboundActivity = {
      active: 1,
      recent: [{ taskId: 't1', messagePreview: 'hi', state: 'running', startedAt: '', caller: { projectName: 'web' } }],
    }
    const label = formatInboundLabel(activity, NOW)
    expect(label?.text).toContain('被调')
    expect(label?.text).toContain('web')
    expect(label?.text).toContain('执行中')
    expect(label?.color).toBe('cyan')
  })

  it('多个执行中显示计数', () => {
    const activity: InboundActivity = {
      active: 2,
      recent: [
        { taskId: 't2', messagePreview: 'b', state: 'running', startedAt: '' },
        { taskId: 't1', messagePreview: 'a', state: 'running', startedAt: '' },
      ],
    }
    expect(formatInboundLabel(activity, NOW)?.text).toContain('2')
  })

  it('最近完成（60s 内）显示完成 + 相对时间（green）', () => {
    const endedAt = new Date(NOW - 3000).toISOString()
    const activity: InboundActivity = {
      active: 0,
      recent: [{ taskId: 't1', messagePreview: 'hi', state: 'completed', startedAt: '', endedAt, durationMs: 1000, caller: { projectName: 'web' } }],
    }
    const label = formatInboundLabel(activity, NOW)
    expect(label?.text).toContain('完成')
    expect(label?.color).toBe('green')
  })

  it('最近失败显示失败（red）', () => {
    const endedAt = new Date(NOW - 1000).toISOString()
    const activity: InboundActivity = {
      active: 0,
      recent: [{ taskId: 't1', messagePreview: 'hi', state: 'failed', startedAt: '', endedAt, durationMs: 1000 }],
    }
    const label = formatInboundLabel(activity, NOW)
    expect(label?.text).toContain('失败')
    expect(label?.color).toBe('red')
  })

  it('超过 60s 的完成记录不再显示', () => {
    const endedAt = new Date(NOW - 61_000).toISOString()
    const activity: InboundActivity = {
      active: 0,
      recent: [{ taskId: 't1', messagePreview: 'hi', state: 'completed', startedAt: '', endedAt, durationMs: 1000 }],
    }
    expect(formatInboundLabel(activity, NOW)).toBeNull()
  })
})

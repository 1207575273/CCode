// tests/unit/core/context-tracker.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import { contextTracker } from '../../../src/core/context-tracker.js'

describe('ContextTracker', () => {
  beforeEach(() => {
    contextTracker.configure({ contextWindow: 128_000, outputReserve: 16_384 })
    contextTracker.reset()
  })

  it('初始状态应为 normal 且 0%', () => {
    const state = contextTracker.getState()
    expect(state.totalWindow).toBe(128_000)
    expect(state.outputReserve).toBe(16_384)
    expect(state.effectiveWindow).toBe(128_000 - 16_384)
    expect(state.lastInputTokens).toBe(0)
    expect(state.usedPercentage).toBe(0)
    expect(state.level).toBe('normal')
  })

  it('update 后应反映精确 token 数', () => {
    contextTracker.update(50_000)
    const state = contextTracker.getState()
    expect(state.lastInputTokens).toBe(50_000)
    expect(state.usedPercentage).toBeCloseTo(50_000 / (128_000 - 16_384), 4)
    expect(state.remaining).toBe(128_000 - 16_384 - 50_000)
    expect(state.level).toBe('normal')
  })

  it('70% 应为 warning', () => {
    const effective = 128_000 - 16_384
    contextTracker.update(Math.floor(effective * 0.72))
    expect(contextTracker.getState().level).toBe('warning')
  })

  it('85% 应为 critical', () => {
    const effective = 128_000 - 16_384
    contextTracker.update(Math.floor(effective * 0.87))
    expect(contextTracker.getState().level).toBe('critical')
  })

  it('95% 应为 overflow', () => {
    const effective = 128_000 - 16_384
    contextTracker.update(Math.floor(effective * 0.96))
    expect(contextTracker.getState().level).toBe('overflow')
  })

  it('shouldAutoCompact 在 >= 95% 时返回 true', () => {
    const effective = 128_000 - 16_384
    contextTracker.update(Math.floor(effective * 0.94))
    expect(contextTracker.shouldAutoCompact()).toBe(false)

    contextTracker.update(Math.floor(effective * 0.96))
    expect(contextTracker.shouldAutoCompact()).toBe(true)
  })

  it('configure 应更新窗口大小', () => {
    contextTracker.configure({ contextWindow: 64_000 })
    const state = contextTracker.getState()
    expect(state.totalWindow).toBe(64_000)
    expect(state.effectiveWindow).toBe(64_000 - 16_384)
  })

  it('reset 应清零', () => {
    contextTracker.update(80_000)
    contextTracker.reset()
    const state = contextTracker.getState()
    expect(state.lastInputTokens).toBe(0)
    expect(state.level).toBe('normal')
  })
})

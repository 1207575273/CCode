/**
 * ModelPicker 按键交互测试
 *
 * 验证 ↑↓ 循环导航、Enter 选择、Escape/q 取消。
 * 用于 ink 6 升级前建立基线，升级后回归验证。
 */

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import { ModelPicker } from '@ui/ModelPicker.js'
import type { ModelItem } from '@ui/ModelPicker.js'

const KEY = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  ENTER: '\r',
  ESCAPE: '\x1b',
} as const

afterEach(cleanup)

const ITEMS: ModelItem[] = [
  { provider: 'anthropic', model: 'claude-sonnet' },
  { provider: 'anthropic', model: 'claude-opus' },
  { provider: 'openai', model: 'gpt-4o' },
]

function renderPicker() {
  const onSelect = vi.fn<(provider: string, model: string) => void>()
  const onCancel = vi.fn<() => void>()
  const instance = render(
    <ModelPicker
      currentProvider="anthropic"
      currentModel="claude-sonnet"
      items={ITEMS}
      onSelect={onSelect}
      onCancel={onCancel}
    />,
  )
  return { ...instance, onSelect, onCancel }
}

describe('ModelPicker keybindings', () => {
  it('should start on current model and confirm with Enter', async () => {
    const { stdin, onSelect } = renderPicker()

    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    // 初始定位到 claude-sonnet (index 0)
    expect(onSelect).toHaveBeenCalledWith('anthropic', 'claude-sonnet')
  })

  it('should navigate down and select', async () => {
    const { stdin, onSelect } = renderPicker()

    await delay()
    stdin.write(KEY.DOWN)
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onSelect).toHaveBeenCalledWith('anthropic', 'claude-opus')
  })

  it('should cycle down: last → first', async () => {
    const { stdin, onSelect } = renderPicker()

    await delay()
    stdin.write(KEY.DOWN)   // → claude-opus
    await delay()
    stdin.write(KEY.DOWN)   // → gpt-4o
    await delay()
    stdin.write(KEY.DOWN)   // → 回到 claude-sonnet（循环）
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onSelect).toHaveBeenCalledWith('anthropic', 'claude-sonnet')
  })

  it('should cycle up: first → last', async () => {
    const { stdin, onSelect } = renderPicker()

    await delay()
    stdin.write(KEY.UP)     // 从第一项上移 → 到最后一项 gpt-4o
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o')
  })

  it('should cancel on Escape', async () => {
    const { stdin, onCancel } = renderPicker()

    await delay()
    stdin.write(KEY.ESCAPE)
    await delay()

    expect(onCancel).toHaveBeenCalled()
  })

  it('should cancel on "q"', async () => {
    const { stdin, onCancel } = renderPicker()

    await delay()
    stdin.write('q')
    await delay()

    expect(onCancel).toHaveBeenCalled()
  })
})

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

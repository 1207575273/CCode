/**
 * PermissionDialog 按键交互测试
 *
 * 验证 ↑↓ 导航、Enter 确认、Escape 拒绝。
 * 用于 ink 6 升级前建立基线，升级后回归验证。
 */

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import { PermissionDialog } from '@ui/PermissionDialog.js'

// 按键常量
const KEY = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  ENTER: '\r',
  ESCAPE: '\x1b',
} as const

afterEach(cleanup)

/** 构造最小 props */
function renderDialog(onResolve?: (...args: unknown[]) => void) {
  const spy = onResolve ?? vi.fn()
  const instance = render(
    <PermissionDialog
      toolName="bash"
      args={{ command: 'echo hello' }}
      onResolve={spy as (allow: boolean, always?: boolean) => void}
    />,
  )
  return { ...instance, onResolve: spy }
}

describe('PermissionDialog keybindings', () => {
  it('should select "Yes" by default and confirm with Enter', async () => {
    const { stdin, onResolve } = renderDialog()

    // 默认选中第一项 Yes，直接按 Enter
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onResolve).toHaveBeenCalledWith(true, false)
  })

  it('should navigate to "Yes, always" with ↓ and confirm', async () => {
    const { stdin, onResolve } = renderDialog()

    await delay()
    stdin.write(KEY.DOWN)   // → "Yes, and don't ask again"
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onResolve).toHaveBeenCalledWith(true, true)
  })

  it('should navigate to "No" with ↓↓ and confirm', async () => {
    const { stdin, onResolve } = renderDialog()

    await delay()
    stdin.write(KEY.DOWN)   // → "Yes, always"
    await delay()
    stdin.write(KEY.DOWN)   // → "No"
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onResolve).toHaveBeenCalledWith(false, false)
  })

  it('should navigate back up with ↑', async () => {
    const { stdin, onResolve } = renderDialog()

    await delay()
    stdin.write(KEY.DOWN)   // → "Yes, always"
    await delay()
    stdin.write(KEY.DOWN)   // → "No"
    await delay()
    stdin.write(KEY.UP)     // → "Yes, always"
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onResolve).toHaveBeenCalledWith(true, true)
  })

  it('should reject on Escape (equivalent to No)', async () => {
    const { stdin, onResolve } = renderDialog()

    await delay()
    stdin.write(KEY.ESCAPE)
    await delay()

    expect(onResolve).toHaveBeenCalledWith(false, false)
  })

  it('should not navigate above first item', async () => {
    const { stdin, onResolve } = renderDialog()

    await delay()
    stdin.write(KEY.UP)     // 已在第一项，不应越界
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    // 仍然是第一项 Yes
    expect(onResolve).toHaveBeenCalledWith(true, false)
  })

  it('should not navigate below last item', async () => {
    const { stdin, onResolve } = renderDialog()

    await delay()
    stdin.write(KEY.DOWN)
    await delay()
    stdin.write(KEY.DOWN)
    await delay()
    stdin.write(KEY.DOWN)   // 超出底部，应停在 No
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onResolve).toHaveBeenCalledWith(false, false)
  })
})

/** ink-testing-library 的 stdin.write 是同步的，但 React 需要一个 tick 来处理状态更新 */
function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

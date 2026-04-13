/**
 * ForkPanel 按键交互测试
 *
 * 验证 ↑↓ 导航、Enter 确认 fork、Escape/q 关闭。
 * 用于 ink 6 升级前建立基线，升级后回归验证。
 */

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import { ForkPanel } from '@ui/ForkPanel.js'
import type { ChatMessage } from '@ui/ChatView.js'

const KEY = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  ENTER: '\r',
  ESCAPE: '\x1b',
} as const

afterEach(cleanup)

const MESSAGES: ChatMessage[] = [
  { id: 'msg-1', role: 'user', content: '你好' },
  { id: 'msg-2', role: 'assistant', content: '你好！有什么可以帮你的？' },
  { id: 'msg-3', role: 'user', content: '写一个 hello world' },
  { id: 'msg-4', role: 'assistant', content: 'console.log("hello world")' },
]

function renderForkPanel() {
  const onFork = vi.fn<(messageId: string) => void>()
  const onClose = vi.fn<() => void>()
  const instance = render(
    <ForkPanel messages={MESSAGES} onFork={onFork} onClose={onClose} />,
  )
  return { ...instance, onFork, onClose }
}

describe('ForkPanel keybindings', () => {
  it('should default to last message and fork with Enter', async () => {
    const { stdin, onFork } = renderForkPanel()

    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    // 默认选中最后一条消息
    expect(onFork).toHaveBeenCalledWith('msg-4')
  })

  it('should navigate up and fork from earlier message', async () => {
    const { stdin, onFork } = renderForkPanel()

    await delay()
    stdin.write(KEY.UP)
    await delay()
    stdin.write(KEY.UP)
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    // 从 msg-4 上移两次到 msg-2
    expect(onFork).toHaveBeenCalledWith('msg-2')
  })

  it('should not navigate above first item', async () => {
    const { stdin, onFork } = renderForkPanel()

    await delay()
    // 连按 10 次 ↑，不应越界
    for (let i = 0; i < 10; i++) {
      stdin.write(KEY.UP)
      await delay()
    }
    stdin.write(KEY.ENTER)
    await delay()

    expect(onFork).toHaveBeenCalledWith('msg-1')
  })

  it('should not navigate below last item', async () => {
    const { stdin, onFork } = renderForkPanel()

    await delay()
    stdin.write(KEY.DOWN)   // 已在最后一项
    await delay()
    stdin.write(KEY.ENTER)
    await delay()

    expect(onFork).toHaveBeenCalledWith('msg-4')
  })

  it('should close on Escape', async () => {
    const { stdin, onClose } = renderForkPanel()

    await delay()
    stdin.write(KEY.ESCAPE)
    await delay()

    expect(onClose).toHaveBeenCalled()
  })

  it('should close on "q"', async () => {
    const { stdin, onClose } = renderForkPanel()

    await delay()
    stdin.write('q')
    await delay()

    expect(onClose).toHaveBeenCalled()
  })
})

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

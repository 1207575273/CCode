/**
 * McpStatusView 按键交互测试
 *
 * 验证 Escape/q 关闭面板。
 * 用于 ink 6 升级前建立基线，升级后回归验证。
 */

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import { McpStatusView } from '@ui/McpStatusView.js'
import type { ServerInfo } from '@mcp/mcp-manager.js'

const KEY = {
  ESCAPE: '\x1b',
} as const

afterEach(cleanup)

const SERVERS: ServerInfo[] = [
  {
    name: 'test-server',
    status: 'connected',
    source: 'project',
    toolCount: 3,
    toolNames: ['tool-a', 'tool-b', 'tool-c'],
  },
]

function renderMcpStatus() {
  const onClose = vi.fn<() => void>()
  const instance = render(
    <McpStatusView servers={SERVERS} onClose={onClose} />,
  )
  return { ...instance, onClose }
}

describe('McpStatusView keybindings', () => {
  it('should close on Escape', async () => {
    const { stdin, onClose } = renderMcpStatus()

    await delay()
    stdin.write(KEY.ESCAPE)
    await delay()

    expect(onClose).toHaveBeenCalled()
  })

  it('should close on "q"', async () => {
    const { stdin, onClose } = renderMcpStatus()

    await delay()
    stdin.write('q')
    await delay()

    expect(onClose).toHaveBeenCalled()
  })
})

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 证明 P0 优化:dbg() 加 CCODE_DEBUG 开关 + 惰性 thunk 后,
 * 关闭调试时既不执行参数里的序列化(thunk 不被调用),也不写盘(appendFileSync 不被调用)。
 *
 * 这是热路径(每个流式 chunk / 每轮整段历史)的核心收益来源:
 * 旧实现无开关,每次调用都同步 appendFileSync + eager 构造日志字符串。
 */

const appendMock = vi.fn()
const mkdirMock = vi.fn()

vi.mock('node:fs', () => ({
  appendFileSync: (...args: unknown[]) => appendMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirMock(...args),
}))

describe('dbg 调试开关与惰性求值', () => {
  const origEnv = process.env.CCODE_DEBUG

  beforeEach(() => {
    appendMock.mockClear()
    mkdirMock.mockClear()
    vi.resetModules() // DEBUG_ENABLED 是模块加载期常量,必须重置后按当前 env 重新加载
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CCODE_DEBUG
    else process.env.CCODE_DEBUG = origEnv
  })

  it('关闭时:thunk 不执行、不写盘', async () => {
    delete process.env.CCODE_DEBUG
    vi.resetModules()
    const { dbg } = await import('../../src/debug.js')

    let thunkCalls = 0
    dbg(() => {
      thunkCalls++
      return 'expensive: ' + JSON.stringify({ a: 1 })
    })

    expect(thunkCalls).toBe(0)         // 序列化根本没发生
    expect(appendMock).not.toHaveBeenCalled() // 没有同步磁盘写
  })

  it('开启时:thunk 执行一次并写盘一次', async () => {
    process.env.CCODE_DEBUG = '1'
    vi.resetModules()
    const { dbg } = await import('../../src/debug.js')

    let thunkCalls = 0
    dbg(() => {
      thunkCalls++
      return 'expensive'
    })

    expect(thunkCalls).toBe(1)
    expect(appendMock).toHaveBeenCalledTimes(1)
  })

  it('开启时:字符串参数也正常写盘(向后兼容)', async () => {
    process.env.CCODE_DEBUG = '1'
    vi.resetModules()
    const { dbg } = await import('../../src/debug.js')

    dbg('plain string')
    expect(appendMock).toHaveBeenCalledTimes(1)
    const written = String(appendMock.mock.calls[0]?.[1] ?? '')
    expect(written).toContain('plain string')
  })
})

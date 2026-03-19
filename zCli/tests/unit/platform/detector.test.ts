import { describe, it, expect } from 'vitest'
import { detectPlatform } from '@platform/detector.js'

describe('detectPlatform', () => {
  it('返回合法的 platform 信息', () => {
    const info = detectPlatform()
    expect(['win32', 'linux', 'darwin']).toContain(info.platform)
    expect(info.homeDir).toBeTruthy()
    expect(info.ccodeDir).toContain('.ccode')
  })

  it('isWindows / isLinux / isMac 三选一', () => {
    const { isWindows, isLinux, isMac } = detectPlatform()
    const trueCount = [isWindows, isLinux, isMac].filter(Boolean).length
    expect(trueCount).toBe(1)
  })
})

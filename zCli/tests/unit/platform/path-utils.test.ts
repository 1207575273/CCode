// tests/unit/platform/path-utils.test.ts
import { describe, it, expect, vi } from 'vitest'

// mock detectPlatform，按需切换 Windows / Linux
const mockDetectPlatform = vi.fn()
vi.mock('@platform/detector.js', () => ({ detectPlatform: () => mockDetectPlatform() }))

// 动态导入以便 mock 生效
const { resolvePath } = await import('@platform/path-utils.js')

describe('resolvePath', () => {
  describe('Windows 环境', () => {
    // Windows 下的 path.resolve 行为依赖真实 OS，这里只在 Windows 上测试
    const isWin = process.platform === 'win32'
    const maybe = isWin ? it : it.skip

    beforeAll(() => {
      mockDetectPlatform.mockReturnValue({ isWindows: true, isMac: false, isLinux: false })
    })

    maybe('MSYS cwd + 相对路径：/c/Users/foo + hello.py → C:\\Users\\foo\\hello.py', () => {
      const result = resolvePath('/c/Users/foo', 'hello.py')
      expect(result).toBe('C:\\Users\\foo\\hello.py')
    })

    maybe('MSYS cwd + 绝对 MSYS 路径：/c/work + /d/other/file.txt → D:\\other\\file.txt', () => {
      const result = resolvePath('/c/work', '/d/other/file.txt')
      expect(result).toBe('D:\\other\\file.txt')
    })

    maybe('MSYS cwd 根路径：/c → C:\\', () => {
      const result = resolvePath('/c', 'test.py')
      expect(result).toBe('C:\\test.py')
    })

    maybe('Windows 原生路径不受影响：C:\\Users\\foo + hello.py', () => {
      const result = resolvePath('C:\\Users\\foo', 'hello.py')
      expect(result).toBe('C:\\Users\\foo\\hello.py')
    })

    maybe('Windows 绝对路径 rawPath 直接使用', () => {
      const result = resolvePath('C:\\whatever', 'D:\\other\\file.txt')
      expect(result).toBe('D:\\other\\file.txt')
    })

    maybe('小写盘符转大写：/d/work → D:\\work', () => {
      const result = resolvePath('/d/work', 'test.txt')
      expect(result).toBe('D:\\work\\test.txt')
    })
  })

  describe('非 Windows 环境（跳过 MSYS 转换）', () => {
    const isLinux = process.platform !== 'win32'
    const maybe = isLinux ? it : it.skip

    beforeAll(() => {
      mockDetectPlatform.mockReturnValue({ isWindows: false, isMac: false, isLinux: true })
    })

    maybe('/c/Users/foo 在 Linux 上保持原样', () => {
      const result = resolvePath('/c/Users/foo', 'hello.py')
      expect(result).toBe('/c/Users/foo/hello.py')
    })
  })
})

/**
 * Bun 运行时兼容层
 *
 * 在非 TTY 环境下（如 CI、子进程、管道），Ink 要求 stdin 支持 setRawMode。
 * Node.js 和 Bun 在非 TTY 时都没有此方法，导致 Ink 崩溃。
 *
 * 此模块在入口最前面执行，检测并 polyfill stdin 的 TTY 属性：
 * - 如果 stdin 已经是 TTY → 不做任何处理
 * - 如果 stdin 不是 TTY → 注入空实现，让 Ink 不崩溃（键盘输入无效但 UI 能渲染）
 *
 * 真正的 TTY 环境（用户在终端中运行）不受影响。
 */

const tty = await import('node:tty')

if (!tty.isatty(0)) {
  // 非 TTY 环境：polyfill stdin 的 TTY 接口
  // 让 Ink 渲染正常，但键盘输入不可用（pipe 模式 / CI 环境）
  const stdin = process.stdin as NodeJS.ReadStream & Record<string, unknown>

  if (!stdin.isTTY) {
    Object.defineProperty(stdin, 'isTTY', { value: true, writable: true })
  }
  if (typeof stdin.setRawMode !== 'function') {
    stdin.setRawMode = function (mode: boolean) {
      ;(this as NodeJS.ReadStream & { isRaw: boolean }).isRaw = mode
      return this as NodeJS.ReadStream
    }
  }
  // Ink 调用 stdin.ref() / stdin.unref() 来控制进程生命周期
  if (typeof stdin.ref !== 'function') {
    stdin.ref = function () { return this }
  }
  if (typeof stdin.unref !== 'function') {
    stdin.unref = function () { return this }
  }
}

// 加载真正的入口
await import('./ccli.js')

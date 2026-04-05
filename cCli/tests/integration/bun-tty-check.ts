/**
 * Bun TTY 兼容性检测脚本
 *
 * 用法（必须在真正的终端中运行，不能在管道/子进程中）：
 *   bun tests/integration/bun-tty-check.ts
 *   node --import tsx tests/integration/bun-tty-check.ts
 *
 * 对比两个运行时的 TTY 支持情况
 */

import * as tty from 'node:tty'

const isBun = typeof globalThis.Bun !== 'undefined'
const runtime = isBun ? `Bun ${Bun.version}` : `Node.js ${process.version}`

console.log(`\n=== TTY 兼容性检测 [${runtime}] ===\n`)

// 1. TTY 检测
console.log('tty.isatty(0) stdin: ', tty.isatty(0))
console.log('tty.isatty(1) stdout:', tty.isatty(1))
console.log('tty.isatty(2) stderr:', tty.isatty(2))

// 2. process.stdin 属性
console.log('\nprocess.stdin.isTTY:       ', process.stdin.isTTY)
console.log('process.stdin.constructor: ', process.stdin.constructor.name)
console.log('process.stdin instanceof tty.ReadStream:', process.stdin instanceof tty.ReadStream)
console.log('typeof setRawMode:         ', typeof process.stdin.setRawMode)

// 3. process.stdout 属性
console.log('\nprocess.stdout.isTTY:      ', process.stdout.isTTY)
console.log('process.stdout.constructor:', process.stdout.constructor.name)

// 4. 尝试 setRawMode
if (typeof process.stdin.setRawMode === 'function') {
  try {
    process.stdin.setRawMode(true)
    console.log('\n✅ setRawMode(true) 成功')
    console.log('   process.stdin.isRaw:', (process.stdin as tty.ReadStream).isRaw)
    process.stdin.setRawMode(false)
    console.log('✅ setRawMode(false) 成功')
  } catch (e) {
    console.log('\n❌ setRawMode 调用失败:', (e as Error).message)
  }
} else {
  console.log('\n⚠ setRawMode 不存在')
  if (!tty.isatty(0)) {
    console.log('  原因：stdin 不是 TTY（可能在子进程/管道/IDE 终端中运行）')
    console.log('  请在真正的终端中运行此脚本：')
    console.log('    Windows: 打开 cmd / PowerShell / Windows Terminal')
    console.log('    Linux/Mac: 打开 bash / zsh 终端')
  }
}

// 5. 环境信息
console.log('\n--- 环境 ---')
console.log('platform:', process.platform)
console.log('arch:    ', process.arch)
console.log('pid:     ', process.pid)
console.log('ppid:    ', process.ppid)
if (isBun) console.log('bun:     ', Bun.version)
else console.log('node:    ', process.version)

console.log('\n请在真正的终端中分别用 bun 和 node(tsx) 运行，对比结果。\n')

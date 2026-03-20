// src/core/workspace-trust.ts

/**
 * 工作目录信任确认 — 防止在敏感目录下误操作。
 *
 * 检测 cwd 是否为用户主目录、根目录等敏感路径，
 * 如果是则弹出确认提示，用户选择信任后才继续。
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

/** 敏感目录列表（小写比较） */
const SENSITIVE_DIRS = new Set([
  resolve(homedir()).toLowerCase(),
  'c:\\',
  'c:\\users',
  'c:\\windows',
  'd:\\',
  '/',
  '/root',
  '/home',
  '/tmp',
])

/** 检查 cwd 是否为敏感目录 */
export function isSensitiveDirectory(cwd: string): boolean {
  const normalized = resolve(cwd).toLowerCase()
  return SENSITIVE_DIRS.has(normalized)
}

/**
 * 弹出工作目录信任确认（同步阻塞终端）。
 * 返回 true = 用户信任，false = 用户拒绝。
 */
export async function confirmWorkspaceTrust(cwd: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })

  return new Promise<boolean>((resolve) => {
    process.stderr.write('\n')
    process.stderr.write('────────────────────────────────────────────────\n')
    process.stderr.write(` Accessing workspace:\n`)
    process.stderr.write(`\n`)
    process.stderr.write(` ${cwd}\n`)
    process.stderr.write(`\n`)
    process.stderr.write(` This looks like a sensitive directory (home, root, etc.).\n`)
    process.stderr.write(` CCode will be able to read, edit, and execute files here.\n`)
    process.stderr.write(`\n`)
    process.stderr.write(` Do you trust this folder? (y/N): `)

    rl.once('line', (answer) => {
      rl.close()
      const yes = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
      if (!yes) {
        process.stderr.write('\n Exited. Navigate to a project directory and try again.\n\n')
      }
      resolve(yes)
    })
  })
}

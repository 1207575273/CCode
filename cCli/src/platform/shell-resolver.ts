// src/platform/shell-resolver.ts
import { existsSync } from 'node:fs'
import { detectPlatform } from './detector.js'

export type ShellType = 'bash' | 'gitbash' | 'powershell' | 'sh'

export interface ResolvedShell {
  type: ShellType
  path: string
  args: string[]
}

// Windows 上 Git Bash 的常见安装位置
const GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  `${process.env['LOCALAPPDATA'] ?? ''}\\Programs\\Git\\bin\\bash.exe`,
]

function findGitBash(): string | null {
  for (const p of GIT_BASH_PATHS) {
    if (existsSync(p)) return p
  }
  // PATH 中查找
  const pathEnv = process.env['PATH'] ?? ''
  for (const dir of pathEnv.split(';')) {
    const candidate = `${dir}\\bash.exe`
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function resolveShell(preferred?: ShellType): ResolvedShell {
  const { isWindows } = detectPlatform()

  if (isWindows) {
    if (preferred !== 'powershell') {
      const gitBash = findGitBash()
      if (gitBash) {
        return { type: 'gitbash', path: gitBash, args: ['-c'] }
      }
    }
    return {
      type: 'powershell',
      path: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command'],
    }
  }

  // Linux / macOS
  const bash = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return { type: bash.endsWith('bash') ? 'bash' : 'sh', path: bash, args: ['-c'] }
}

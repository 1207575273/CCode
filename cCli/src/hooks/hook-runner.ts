// src/hooks/hook-runner.ts

import { spawn } from 'node:child_process'

export interface RunOptions {
  command: string
  cwd: string
  env: Record<string, string>
  timeout: number
  stdin?: string
}

/**
 * HookRunner — 子进程执行引擎
 * 负责执行单个 hook 命令（spawn 子进程），解析 JSON stdout，处理超时和错误。
 */
export class HookRunner {
  /** 执行 hook 命令，返回解析后的 JSON 或 null */
  async run(opts: RunOptions): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const { command, cwd, env, timeout, stdin } = opts

      const child = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let settled = false

      const settle = (value: Record<string, unknown> | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }

      // 手动超时控制（spawn 的 timeout 在 Windows 上不可靠）
      const timer = setTimeout(() => {
        child.kill()
        settle(null)
      }, timeout)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.on('error', () => settle(null))
      child.on('close', (code) => {
        if (code !== 0) return settle(null)
        try {
          const parsed: unknown = JSON.parse(stdout.trim())
          if (typeof parsed === 'object' && parsed !== null) {
            settle(parsed as Record<string, unknown>)
          } else {
            settle(null)
          }
        } catch {
          settle(null)  // hook 子进程 stdout 非合法 JSON，返回 null（预期行为）
        }
      })

      if (stdin) {
        child.stdin.write(stdin)
      }
      child.stdin.end()
    })
  }
}

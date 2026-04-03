// src/tools/bash.ts
import { spawn } from 'node:child_process'
import { execa } from 'execa'
import { resolveShell } from '@platform/shell-resolver.js'
import { detectPlatform } from '@platform/detector.js'
import { getSnapshotPath } from '@platform/shell-snapshot.js'
import { registerProcess, unregisterProcess, appendOutput, markDone } from './process-tracker.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

/** 默认超时 120 秒 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 最大超时 600 秒（10 分钟） */
const MAX_TIMEOUT_MS = 600_000

export class BashTool implements Tool {
  readonly name = 'bash'
  readonly dangerous = true
  readonly description =
    '执行 Shell 命令。支持 timeout（毫秒，默认 120000，上限 600000）和 run_in_background（后台运行，立即返回 PID）。'
  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: { type: 'string', description: '工作目录，默认为当前目录' },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒），默认 120000，上限 600000',
      },
      run_in_background: {
        type: 'boolean',
        description: '后台运行，立即返回进程 PID，不等待命令结束',
      },
    },
    required: ['command'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args['command'] ?? '')
    if (!command.trim()) {
      return { success: false, output: '', error: '命令不能为空' }
    }

    const cwd = String(args['cwd'] ?? ctx.cwd)
    const shell = resolveShell()
    const runInBackground = args['run_in_background'] === true

    // 解析 timeout：无效值 / 负数 / 0 → 默认值，超过上限 → 截断
    const rawTimeout = Number(args['timeout'])
    const timeout =
      !Number.isFinite(rawTimeout) || rawTimeout <= 0
        ? DEFAULT_TIMEOUT_MS
        : Math.min(rawTimeout, MAX_TIMEOUT_MS)

    // ---- 后台运行模式 ----
    if (runInBackground) {
      return this.#runBackground(shell, command, cwd)
    }

    // ---- 前台运行（等待结束）----
    // 有快照时 source 快照并跳过 login shell（-l），省去 .bashrc 完整初始化
    const snapshotPath = getSnapshotPath()
    const finalCommand = snapshotPath
      ? `source '${snapshotPath}' 2>/dev/null || true && ${command}`
      : command
    const shellArgs = snapshotPath
      ? ['-c', finalCommand]           // 有快照：不传 -l
      : [...shell.args, finalCommand]  // 无快照：保持原行为

    // 用 child_process.spawn 替代 execa（减少模块开销），手动实现 timeout
    return new Promise<ToolResult>((resolve) => {
      let timedOut = false
      let stdout = ''
      let stderr = ''

      const child = spawn(shell.path, shellArgs, {
        cwd,
        stdio: 'pipe',
        windowsHide: true,
      })

      // 手动 timeout：到时间 kill 进程
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        // 给 SIGTERM 500ms 宽限期，之后强制 SIGKILL
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ } }, 500)
      }, timeout)

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      child.on('close', (code) => {
        clearTimeout(timer)
        const output = [stdout, stderr].filter(Boolean).join('\n')

        if (timedOut) {
          resolve({ success: false, output, error: `Command timed out after ${timeout} milliseconds` })
        } else if (code === 0) {
          resolve({ success: true, output: output || '(no output)' })
        } else {
          resolve({ success: false, output: output || '', error: `Exit code ${code}` })
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ success: false, output: '', error: err.message })
      })
    })
  }

  /** 后台模式：启动进程后立即 unref 并返回 PID */
  #runBackground(
    shell: { path: string; args: string[] },
    command: string,
    cwd: string,
  ): ToolResult {
    try {
      const child = execa(shell.path, [...shell.args, command], {
        cwd,
        detached: true,
        stdio: 'pipe',  // 管道模式，捕获输出供 task_output 读取
      })
      // 分离子进程，不阻塞父进程退出
      child.unref()

      // 关键：execa 返回的是 Promise-like 对象，后台进程退出时如果 exitCode != 0
      // 会产生 rejected promise。不捕获会导致 unhandled rejection 崩溃主进程。
      child.catch(() => { /* 后台进程退出错误静默忽略 */ })

      const pid = child.pid
      if (pid != null) {
        // 注册到进程追踪器，供 kill_shell / task_output 工具使用
        registerProcess(pid, command, cwd)

        // 捕获 stdout / stderr 输出到 tracker 缓冲区
        child.stdout?.on('data', (data: Buffer) => appendOutput(pid, data.toString()))
        child.stderr?.on('data', (data: Buffer) => appendOutput(pid, data.toString()))

        // unref stdio 流，不阻塞父进程退出（仅 Socket 类型有 unref）
        if (child.stdout && 'unref' in child.stdout) (child.stdout as any).unref()
        if (child.stderr && 'unref' in child.stderr) (child.stderr as any).unref()

        // 进程退出时记录退出码，延迟清理（给 task_output 留读取窗口）
        child.on('exit', (code) => {
          markDone(pid, code)
          // 30 秒后自动清理，避免内存泄漏
          setTimeout(() => unregisterProcess(pid), 30_000).unref()
        })
      }
      const killHint = buildKillHint(pid)
      return {
        success: true,
        output: `Background process started (pid: ${pid}). Use task_output tool to read output, or kill_shell to stop it.\n${killHint}`,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: message }
    }
  }
}

/**
 * 根据平台生成终止后台进程的提示命令。
 *
 * Windows + Git Bash 环境下 `kill PID` 对 Windows 原生进程不可靠，
 * 而 `taskkill /F /PID <pid>` 的 `/F` 会被 MSYS 路径转换解释为 Unix 路径。
 * 解决方案：使用双斜杠 `//F` 绕过 MSYS 路径转换。
 */
function buildKillHint(pid: number | undefined): string {
  if (pid == null) return ''
  const { isWindows } = detectPlatform()
  if (isWindows) {
    // 双斜杠绕过 MSYS 的 Unix 路径自动转换
    return `Use "taskkill //F //PID ${pid}" to stop it.`
  }
  return `Use "kill ${pid}" to stop it.`
}

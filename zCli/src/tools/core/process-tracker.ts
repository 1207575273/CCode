// src/tools/process-tracker.ts

/**
 * 后台进程注册表 — 追踪 BashTool 启动的后台进程。
 *
 * 模块级单例，记录 PID → 进程信息的映射。
 * KillShellTool 通过此注册表查询和终止进程。
 *
 * 安全约束：只追踪由 bash 工具 run_in_background 启动的进程，
 * 不追踪系统进程或其他来源的进程。
 */

import { detectPlatform } from '@platform/detector.js'

/** 输出缓冲区最大字节数（1MB），超出后截断头部保留尾部 */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** 后台进程信息 */
export interface TrackedProcess {
  pid: number
  command: string
  cwd: string
  startedAt: Date
  /** 捕获的 stdout + stderr 输出片段 */
  outputChunks: string[]
  /** 输出累计字节数（用于截断判断） */
  outputBytes: number
  /** 进程退出码（结束后填入） */
  exitCode?: number | null
  /** 进程是否已结束 */
  done: boolean
}

/** PID → 进程信息 */
const processes = new Map<number, TrackedProcess>()

/** 注册后台进程（BashTool 启动时调用） */
export function registerProcess(pid: number, command: string, cwd: string): void {
  processes.set(pid, {
    pid, command, cwd,
    startedAt: new Date(),
    outputChunks: [],
    outputBytes: 0,
    done: false,
  })
}

/** 取消注册（进程结束时调用） */
export function unregisterProcess(pid: number): void {
  processes.delete(pid)
}

/** 获取所有追踪中的进程 */
export function listProcesses(): TrackedProcess[] {
  return [...processes.values()]
}

/** 检查 PID 是否在追踪列表中 */
export function isTracked(pid: number): boolean {
  return processes.has(pid)
}

/** 获取指定进程信息 */
export function getProcess(pid: number): TrackedProcess | undefined {
  return processes.get(pid)
}

/**
 * 终止指定 PID 的进程。
 *
 * @returns 终止结果：success + 描述信息
 */
export async function killProcess(pid: number): Promise<{ success: boolean; message: string }> {
  const proc = processes.get(pid)
  if (!proc) {
    return { success: false, message: `PID ${pid} 不在追踪列表中（只能终止由 bash run_in_background 启动的进程）` }
  }

  try {
    const { isWindows } = detectPlatform()
    if (isWindows) {
      // Windows: taskkill /F /PID xxx /T（含子进程树）
      const { execa } = await import('execa')
      await execa('taskkill', ['/F', '/PID', String(pid), '/T'], { reject: false })
    } else {
      // Unix: 先 SIGTERM，给进程 graceful shutdown 的机会
      process.kill(pid, 'SIGTERM')
    }

    processes.delete(pid)
    return { success: true, message: `进程 ${pid} 已终止 (${truncCmd(proc.command)})` }
  } catch (err) {
    // 进程可能已退出
    processes.delete(pid)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ESRCH') || msg.includes('not found') || msg.includes('找不到')) {
      return { success: true, message: `进程 ${pid} 已不存在（可能已自行退出）` }
    }
    return { success: false, message: `终止进程 ${pid} 失败: ${msg}` }
  }
}

/** 终止所有追踪中的进程 */
export async function killAllProcesses(): Promise<{ killed: number; failed: number }> {
  let killed = 0
  let failed = 0
  for (const pid of [...processes.keys()]) {
    const result = await killProcess(pid)
    if (result.success) killed++
    else failed++
  }
  return { killed, failed }
}

/**
 * 追加输出到进程缓冲区。
 * 超过 MAX_OUTPUT_BYTES 时丢弃最早的片段，保留尾部。
 */
export function appendOutput(pid: number, chunk: string): void {
  const proc = processes.get(pid)
  if (!proc) return

  proc.outputChunks.push(chunk)
  proc.outputBytes += Buffer.byteLength(chunk, 'utf-8')

  // 超限时从头部丢弃，直到低于阈值
  while (proc.outputBytes > MAX_OUTPUT_BYTES && proc.outputChunks.length > 1) {
    const removed = proc.outputChunks.shift()!
    proc.outputBytes -= Buffer.byteLength(removed, 'utf-8')
  }
}

/** 获取进程已捕获的全部输出（拼接后返回） */
export function getOutput(pid: number): string | undefined {
  const proc = processes.get(pid)
  if (!proc) return undefined
  return proc.outputChunks.join('')
}

/** 标记进程已结束，记录退出码 */
export function markDone(pid: number, exitCode: number | null): void {
  const proc = processes.get(pid)
  if (!proc) return
  proc.done = true
  proc.exitCode = exitCode
}

/** 截断命令显示（过长时省略） */
function truncCmd(cmd: string): string {
  return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
}

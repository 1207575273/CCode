/**
 * Shell 快照机制 — CLI 启动时冻结 shell 环境，后续命令 source 快照跳过 login shell 初始化。
 *
 * 原理：
 *   bash -c -l "command"  → 每次走 /etc/profile → ~/.bashrc，Windows Git Bash 上 ~80ms
 *   bash -c "source snapshot && command"  → 直接恢复环境，~10ms
 *
 * 快照内容：函数定义（base64）、shopt 选项、别名、PATH
 * 参考：Claude Code CLI 的 ShellSnapshot.ts + bashProvider.ts
 */

import { execFile } from 'node:child_process'
import { mkdir, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveShell } from './shell-resolver.js'
import { detectPlatform } from './detector.js'

/** 快照创建超时（用户 .bashrc 可能有网络请求等副作用） */
const SNAPSHOT_TIMEOUT_MS = 10_000

let _snapshotPath: string | undefined
let _snapshotPromise: Promise<string | undefined> | undefined

/**
 * 异步创建 Shell 快照。CLI 启动时调用一次，不阻塞其他初始化。
 * 返回快照文件路径；失败返回 undefined（降级为 login shell）。
 */
export function startSnapshotCreation(): Promise<string | undefined> {
  if (_snapshotPromise) return _snapshotPromise

  _snapshotPromise = createSnapshot()
  return _snapshotPromise
}

/** 获取已创建的快照路径（同步，快照创建完成后可用） */
export function getSnapshotPath(): string | undefined {
  return _snapshotPath
}

/** 清理快照文件（CLI 退出时调用） */
export async function cleanupSnapshot(): Promise<void> {
  if (_snapshotPath) {
    try { await unlink(_snapshotPath) } catch { /* 文件可能已不存在 */ }
    _snapshotPath = undefined
  }
}

async function createSnapshot(): Promise<string | undefined> {
  const shell = resolveShell()
  // PowerShell 不需要快照（无 login shell 初始化开销）
  if (shell.type === 'powershell') return undefined

  const { isWindows, ccodeDir } = detectPlatform()

  const snapshotsDir = join(ccodeDir, 'shell-snapshots')
  try {
    await mkdir(snapshotsDir, { recursive: true })
  } catch {
    return undefined
  }

  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  const snapshotFile = join(snapshotsDir, `snapshot-${shell.type}-${ts}-${rand}.sh`)

  // 用户 shell 配置文件路径
  const { homeDir } = detectPlatform()
  const configFile = shell.type === 'bash' || shell.type === 'gitbash'
    ? join(homeDir, '.bashrc')
    : join(homeDir, '.profile')

  const script = buildSnapshotScript(snapshotFile, configFile, isWindows)

  return new Promise<string | undefined>((resolve) => {
    execFile(
      shell.path,
      ['-c', '-l', script],
      {
        timeout: SNAPSHOT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_EDITOR: 'true' },
        windowsHide: true,
      },
      async (error) => {
        if (error) {
          resolve(undefined)
          return
        }
        try {
          await access(snapshotFile)
          _snapshotPath = snapshotFile
          resolve(snapshotFile)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}

/**
 * 构建快照生成脚本。
 * 在 login shell 中执行，source 用户配置后导出环境到文件。
 */
function buildSnapshotScript(snapshotFile: string, configFile: string, isWindows: boolean): string {
  // 单引号转义：'abc' → 'abc'\''def'
  const esc = (s: string) => s.replace(/'/g, "'\\''" )

  // 别名导出：Windows 过滤 winpty 别名（无 TTY 时会报 "stdin is not a tty"）
  const aliasExport = isWindows
    ? `alias | grep -v "='winpty " | sed "s/^alias //g" | sed "s/^/alias -- /" | head -n 200 >> "$SF"`
    : `alias | sed "s/^alias //g" | sed "s/^/alias -- /" | head -n 200 >> "$SF"`

  return [
    `SF='${esc(snapshotFile)}'`,
    // source 用户配置（stdin 重定向 /dev/null 防止交互式命令阻塞）
    `[ -f '${esc(configFile)}' ] && source '${esc(configFile)}' < /dev/null 2>/dev/null`,
    '',
    `echo "# Shell snapshot" >| "$SF"`,
    // 清除别名防止与函数冲突
    `echo "unalias -a 2>/dev/null || true" >> "$SF"`,
    '',
    // 导出函数（base64 编码，避免特殊字符问题）
    `echo "# Functions" >> "$SF"`,
    `declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read -r func; do`,
    `  encoded=$(declare -f "$func" | base64)`,
    `  echo "eval \\"\\$(echo '$encoded' | base64 -d)\\" > /dev/null 2>&1" >> "$SF"`,
    `done`,
    '',
    // 导出 shell 选项
    `echo "# Shell Options" >> "$SF"`,
    `shopt -p 2>/dev/null | head -n 200 >> "$SF"`,
    `set -o 2>/dev/null | grep "on" | awk '{print "set -o " $1}' | head -n 100 >> "$SF"`,
    `echo "shopt -s expand_aliases" >> "$SF"`,
    '',
    // 导出别名
    `echo "# Aliases" >> "$SF"`,
    aliasExport,
    '',
    // 导出 PATH
    `echo "export PATH='$PATH'" >> "$SF"`,
  ].join('\n')
}

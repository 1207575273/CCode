// src/platform/path-utils.ts
import { resolve, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { detectPlatform } from './detector.js'

/**
 * 防御式解析真实 home 目录 —— 绝不依赖单一来源。
 *
 * 背景：os.homedir() 在多数环境可靠，但在沙箱/容器/CI/受限 shell 下可能
 * 返回 '/'、空串或不存在的路径，导致配置写到错误位置。这里逐源回退并用
 * existsSync 校验，保证返回的一定是「真实存在的目录」。
 *
 * 优先级（命中一个存在的目录即返回）：
 *   1. os.homedir()
 *   2. Windows: %USERPROFILE% -> %HOMEDRIVE%%HOMEPATH%；类 Unix: $HOME
 *   3. 全部失败：返回 os.homedir() 原值（保持可预期），再兜底 os.tmpdir()
 */
export function resolveHomeDir(): string {
  const fromOs = homedir()
  const candidates: (string | undefined)[] = [fromOs]

  if (process.platform === 'win32') {
    candidates.push(process.env['USERPROFILE'])
    const drive = process.env['HOMEDRIVE']
    const path = process.env['HOMEPATH']
    if (drive && path) candidates.push(drive + path)
  } else {
    candidates.push(process.env['HOME'])
  }

  for (const candidate of candidates) {
    if (candidate && candidate !== '/' && existsSync(candidate)) return candidate
  }

  // 全部不可用：优先返回 os.homedir() 原值（即便不存在也比随机路径可预期），最后兜底临时目录
  return fromOs && fromOs !== '/' ? fromOs : tmpdir()
}

/**
 * ccode 全局配置根目录（默认 <home>/.ccode）。
 *
 * 支持 CCODE_HOME 环境变量显式覆盖：用于测试隔离（重定向到临时目录，
 * 避免污染真实 ~/.ccode）或特殊部署。覆盖值直接作为配置根，不再追加 .ccode。
 */
export function ccodeHome(): string {
  const override = process.env['CCODE_HOME']
  if (override && override.trim()) return override
  return join(resolveHomeDir(), '.ccode')
}

/**
 * MSYS/Git Bash 路径转 Windows 原生路径
 * /c/Users/foo → C:\Users\foo
 * /d/work      → D:\work
 * 非 MSYS 格式或非 Windows 平台直接原样返回
 */
function msysToWin(p: string): string {
  // 匹配 /x/ 或 /x 开头（x 为单字母盘符）
  const match = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  if (!match) return p
  const drive = match[1]!.toUpperCase()
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${drive}:${rest || '\\'}`
}

/**
 * 将可能的 MSYS 路径 + 相对路径解析为当前平台的绝对路径
 * Windows 上先把 MSYS 格式转为 Win 路径再 resolve
 * 其他平台直接 resolve
 */
export function resolvePath(cwd: string, rawPath: string): string {
  const { isWindows } = detectPlatform()
  if (isWindows) {
    return resolve(msysToWin(cwd), msysToWin(rawPath))
  }
  return resolve(cwd, rawPath)
}

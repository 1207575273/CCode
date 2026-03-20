// src/platform/path-utils.ts
import { resolve } from 'node:path'
import { detectPlatform } from './detector.js'

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

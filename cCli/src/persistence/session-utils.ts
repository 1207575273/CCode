import { v7 as uuidv7, v4 as uuidv4 } from 'uuid'
import { execSync } from 'node:child_process'

/** 将 cwd 路径转为文件系统安全的目录名（与 Claude Code 一致） */
export function toProjectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-')
}

/** 生成 UUIDv7（时间有序） */
export function generateSessionId(): string {
  return uuidv7()
}

/** 生成普通 UUIDv4（事件 ID） */
export function generateEventId(): string {
  return uuidv4()
}

/** 格式化会话文件名: YYYYMMDDHHMMSSMMM_<sessionId>.jsonl */
export function formatSessionFilename(sessionId: string, date: Date = new Date()): string {
  const y = date.getUTCFullYear()
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${y}${mo}${d}${h}${mi}${s}${ms}_${sessionId}.jsonl`
}

/** 从文件名中提取 sessionId */
export function extractSessionId(filename: string): string {
  const match = filename.match(/^\d{17}_(.+)\.jsonl$/)
  return match?.[1] ?? filename.replace('.jsonl', '')
}

/** 获取当前 git 分支名，失败返回 'unknown' */
export function getGitBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000 }).trim()
  } catch {
    return 'unknown'  // 非 git 仓库或 git 未安装，预期行为
  }
}

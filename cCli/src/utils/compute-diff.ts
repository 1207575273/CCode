import { readFileSync } from 'node:fs'
import { structuredPatch } from 'diff'

// --- 常量 ---
/** 大型 diff 最多展示的 hunk 数量 */
export const MAX_HUNKS = 5
/** 新文件预览最多展示的行数 */
export const NEW_FILE_MAX_LINES = 20
/** 二进制检测扫描的字节数 */
const BINARY_CHECK_BYTES = 8000

// --- 类型 ---
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 每行带 +/- /空格前缀 */
  lines: string[]
}

export interface DiffData {
  filePath: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
  isNewFile: boolean
  truncatedLines?: number | undefined
  error?: string | undefined
}

// --- 内部工具 ---

/** 检测内容是否为二进制（前 BINARY_CHECK_BYTES 字节内含 null byte） */
function isBinary(content: string): boolean {
  const checkLen = Math.min(content.length, BINARY_CHECK_BYTES)
  for (let i = 0; i < checkLen; i++) {
    if (content.charCodeAt(i) === 0) return true
  }
  return false
}

/** 安全读取文件，不存在返回 null，其他错误抛出 */
function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/** 从 hunks 中统计增删行数 */
function countChanges(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { additions, deletions }
}

/** 将 structuredPatch 的 hunks 转换为 DiffHunk[]，并限制数量 */
function buildHunks(rawHunks: Array<{
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}>): DiffHunk[] {
  return rawHunks.slice(0, MAX_HUNKS).map(h => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: [...h.lines],
  }))
}

// --- 公开 API ---

/**
 * 计算 edit_file（字符串替换）操作的 diff
 *
 * 读取文件原始内容，将 oldStr 替换为 newStr，然后对比新旧内容。
 */
export function computeEditDiff(
  filePath: string,
  oldStr: string,
  newStr: string,
): DiffData {
  try {
    const original = safeReadFile(filePath)

    if (original === null) {
      return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: `File not found: ${filePath}` }
    }

    if (isBinary(original)) {
      return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: 'Binary file — diff not available' }
    }

    // replace 只替换第一个匹配，与 EditFileTool 行为一致（old_str 必须唯一）
    const updated = original.replace(oldStr, newStr)
    const patch = structuredPatch(filePath, filePath, original, updated)
    const hunks = buildHunks(patch.hunks)
    const { additions, deletions } = countChanges(hunks)

    return { filePath, hunks, additions, deletions, isNewFile: false }
  } catch (err) {
    return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 计算 write_file（整体写入）操作的 diff
 *
 * 如果文件已存在，对比旧内容与新内容；如果是新文件，对比空字符串与新内容。
 * 新文件超过 NEW_FILE_MAX_LINES 行时截断展示。
 */
export function computeWriteDiff(
  filePath: string,
  newContent: string,
): DiffData {
  try {
    const existing = safeReadFile(filePath)
    const isNewFile = existing === null

    if (!isNewFile && isBinary(existing)) {
      return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: 'Binary file — diff not available' }
    }

    const oldContent = existing ?? ''
    let diffNewContent = newContent
    let truncatedLines: number | undefined

    // 新文件超过 NEW_FILE_MAX_LINES 行时截断
    if (isNewFile) {
      const lines = newContent.split('\n')
      const effectiveLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      if (effectiveLines > NEW_FILE_MAX_LINES) {
        truncatedLines = effectiveLines - NEW_FILE_MAX_LINES
        diffNewContent = lines.slice(0, NEW_FILE_MAX_LINES).join('\n') + '\n'
      }
    }

    const patch = structuredPatch(filePath, filePath, oldContent, diffNewContent)
    const hunks = buildHunks(patch.hunks)
    const { additions, deletions } = countChanges(hunks)

    const result: DiffData = { filePath, hunks, additions, deletions, isNewFile }
    if (truncatedLines !== undefined) {
      result.truncatedLines = truncatedLines
    }
    return result
  } catch (err) {
    return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: true, error: err instanceof Error ? err.message : String(err) }
  }
}

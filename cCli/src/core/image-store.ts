// src/core/image-store.ts

/**
 * ImageStore — 图片文件读写管理模块。
 *
 * 纯 I/O 操作，无业务逻辑。
 * 被 Dashboard API（写入）和 Provider（读取）调用。
 * 存储路径：{cwd}/.ccode/images/{uuid}.{ext}
 * 图片跟随项目目录，不放全局 ~/.ccode（与项目上下文关联更紧密）。
 * 只暴露 id，不暴露文件路径。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'node:fs'

/** 图片存储目录：项目运行目录下的 .ccode/images/ */
function getImagesDir(): string {
  return join(process.cwd(), '.ccode', 'images')
}

/** 图片元信息 */
export interface ImageMeta {
  id: string // UUID
  fileName: string // {id}.jpg
  mediaType: string // image/jpeg | image/png | image/webp
  sizeBytes: number
}

/** 支持的 mediaType → 文件扩展名映射 */
const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

/** 扩展名 → mediaType 反向映射，readImageBase64 时根据文件扩展名反推 */
const MEDIA_TYPE_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * 在 getImagesDir() 中查找以 imageId 开头的文件。
 * 因为调用方只持有 id 不知道扩展名，需要遍历目录匹配。
 */
function findImageFile(imageId: string): string | null {
  try {
    if (!existsSync(getImagesDir())) return null
    const files = readdirSync(getImagesDir())
    const match = files.find((f) => f.startsWith(imageId))
    return match ? join(getImagesDir(), match) : null
  } catch {
    return null
  }
}

/** 从文件路径提取扩展名（含点号） */
function getExtFromPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.')
  return dotIndex >= 0 ? filePath.slice(dotIndex) : ''
}

/** 写入图片文件，返回元信息 */
export function writeImage(buffer: Buffer, mediaType: string): ImageMeta {
  mkdirSync(getImagesDir(), { recursive: true })

  const id = randomUUID()
  // 不支持的 mediaType 回退为 .jpg，避免调用方传入未知类型时写入失败
  const ext = EXT_MAP[mediaType] ?? '.jpg'
  const fileName = `${id}${ext}`
  const filePath = join(getImagesDir(), fileName)

  writeFileSync(filePath, buffer)

  return {
    id,
    fileName,
    mediaType,
    sizeBytes: buffer.length,
  }
}

/** 读取图片为 base64（Provider 发送时调用），文件不存在返回 null */
export function readImageBase64(
  imageId: string,
): { base64: string; mediaType: string } | null {
  try {
    const filePath = findImageFile(imageId)
    if (!filePath) return null

    const buffer = readFileSync(filePath)
    const ext = getExtFromPath(filePath)
    // 未知扩展名回退为 image/jpeg，与写入时的默认扩展名保持一致
    const mediaType = MEDIA_TYPE_MAP[ext] ?? 'image/jpeg'

    return {
      base64: buffer.toString('base64'),
      mediaType,
    }
  } catch {
    return null
  }
}

/** 检查图片文件是否存在 */
export function imageExists(imageId: string): boolean {
  try {
    return findImageFile(imageId) !== null
  } catch {
    return false
  }
}

/** 清理超过 retentionDays 的图片，返回删除数量。用文件 mtime 判断过期，比解析 UUID 时间戳更通用。 */
export function cleanupImages(retentionDays: number): number {
  try {
    if (!existsSync(getImagesDir())) return 0

    const files = readdirSync(getImagesDir())
    const now = Date.now()
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000
    let deletedCount = 0

    for (const file of files) {
      try {
        const filePath = join(getImagesDir(), file)
        const stat = statSync(filePath)
        if (now - stat.mtimeMs > retentionMs) {
          unlinkSync(filePath)
          deletedCount++
        }
      } catch {
        // 单个文件删除失败不影响其他文件的清理
      }
    }

    return deletedCount
  } catch {
    return 0
  }
}

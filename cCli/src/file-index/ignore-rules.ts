// src/file-index/ignore-rules.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'

/**
 * 内置硬编码排除规则
 * 包含版本控制目录、构建产物、二进制文件、媒体文件等
 */
const BUILTIN_IGNORE_PATTERNS: string[] = [
  // 版本控制 & 工具目录
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.ccode',

  // 锁文件 & 压缩产物
  '*.lock',
  '*.min.js',
  '*.min.css',
  '*.map',

  // 编译产物
  '*.pyc',
  '*.class',
  '*.o',
  '*.so',
  '*.dll',

  // 系统文件
  '.DS_Store',
  'Thumbs.db',

  // 敏感配置
  '.env',
  '.env.*',

  // 测试覆盖率 & 缓存
  'coverage',
  '.nyc_output',
  '.cache',

  // 图片 & 字体
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.gif',
  '*.ico',
  '*.svg',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',

  // 音视频
  '*.mp3',
  '*.mp4',
  '*.avi',
  '*.mov',

  // 压缩包
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.7z',

  // 可执行 & 文档二进制
  '*.exe',
  '*.bin',
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
]

/**
 * 安全读取文件内容，文件不存在时返回空字符串
 */
function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''  // 文件不存在或无权限，返回空内容（预期行为）
  }
}

/**
 * 创建忽略规则过滤器
 *
 * 合并三层规则：内置硬编码 → .gitignore → .ccodeignore
 * 优先级：后添加的规则覆盖先添加的
 *
 * @param cwd - 项目根目录
 * @returns ignore 实例，可用于 filter / ignores 判断
 */
export function createIgnoreFilter(cwd: string): Ignore {
  const ig = ignore()

  // 第一层：内置排除规则
  ig.add(BUILTIN_IGNORE_PATTERNS)

  // 第二层：.gitignore（不存在则跳过）
  const gitignoreContent = readFileSafe(join(cwd, '.gitignore'))
  if (gitignoreContent) {
    ig.add(gitignoreContent)
  }

  // 第三层：.ccodeignore（不存在则跳过）
  const ccodeIgnoreContent = readFileSafe(join(cwd, '.ccodeignore'))
  if (ccodeIgnoreContent) {
    ig.add(ccodeIgnoreContent)
  }

  return ig
}

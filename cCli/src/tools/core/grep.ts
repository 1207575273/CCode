// src/tools/grep.ts
import { readFile, stat } from 'node:fs/promises'
import { resolvePath } from '@platform/path-utils.js'
import fg from 'fast-glob'
import type { Tool, ToolContext, ToolResult } from './types.js'

const MAX_RESULTS = 50

export class GrepTool implements Tool {
  readonly name = 'grep'
  readonly dangerous = false
  readonly description = [
    '在文件中搜索文本模式（支持正则表达式），返回匹配行及行号。',
    '',
    '注意事项：',
    '• pattern 支持 JavaScript 正则语法（默认忽略大小写）',
    '• 搜索目录时默认递归子目录，自动排除 node_modules 和 .git',
    '• 最多返回 50 条匹配结果，超出时请缩小搜索范围（指定更精确的 path 或 pattern）',
    '• 定位代码位置的推荐流程：先 grep 搜索关键词 → 再 read_file 阅读具体文件',
    '• 搜索文件名请用 glob，grep 用于搜索文件内容',
  ].join('\n')
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索关键词或正则表达式（如 "functionName"、"import.*xxx"）' },
      path: { type: 'string', description: '搜索路径（文件或目录，默认当前目录）' },
      recursive: { type: 'boolean', description: '是否递归子目录（默认 true）' },
    },
    required: ['pattern'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args['pattern'] ?? '')
    const searchPath = resolvePath(ctx.cwd, String(args['path'] ?? ctx.cwd))
    const recursive = args['recursive'] !== false

    try {
      const regex = new RegExp(pattern, 'i')
      let files: string[]

      let fileStat: Awaited<ReturnType<typeof stat>> | null = null
      try {
        fileStat = await stat(searchPath)
      } catch { /* path does not exist */ }

      if (fileStat?.isFile()) {
        files = [searchPath]
      } else {
        const glob = recursive ? '**/*' : '*'
        files = await fg(glob, { cwd: searchPath, dot: false, onlyFiles: true, absolute: true })
      }

      const results: string[] = []
      let totalMatches = 0
      let matchedFiles = 0
      for (const file of files) {
        if (results.length >= MAX_RESULTS) break
        try {
          const lines = (await readFile(file, 'utf-8')).split('\n')
          let fileHasMatch = false
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!
            if (regex.test(line)) {
              totalMatches++
              if (!fileHasMatch) {
                fileHasMatch = true
                matchedFiles++
              }
              if (results.length < MAX_RESULTS) {
                results.push(`${file}:${i + 1}: ${line}`)
              }
            }
          }
        } catch { /* 跳过无法读取的文件 */ }
      }

      if (results.length === 0) {
        return { success: true, output: 'No matches found.', meta: { type: 'grep', totalMatches: 0, displayedMatches: 0, truncated: false, fileCount: 0 } }
      }
      const truncated = totalMatches > results.length
      return {
        success: true,
        output: results.join('\n') + (truncated ? `\n[结果已截断，显示 ${results.length}/${totalMatches} 条]` : ''),
        meta: { type: 'grep', totalMatches, displayedMatches: results.length, truncated, fileCount: matchedFiles },
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

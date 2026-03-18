// src/tools/grep.ts
import { readFile, stat } from 'node:fs/promises'
import { resolvePath } from '@platform/path-utils.js'
import fg from 'fast-glob'
import type { Tool, ToolContext, ToolResult } from './types.js'

const MAX_RESULTS = 50

export class GrepTool implements Tool {
  readonly name = 'grep'
  readonly dangerous = false
  readonly description = '在文件中搜索文本模式，返回匹配的行（含行号）。'
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索关键词或正则表达式' },
      path: { type: 'string', description: '搜索路径（文件或目录）' },
      recursive: { type: 'boolean', description: '是否递归搜索子目录' },
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
        return { success: true, output: 'No matches found.', meta: { type: 'grep', matchCount: 0, fileCount: 0 } }
      }
      const truncated = results.length >= MAX_RESULTS
      return {
        success: true,
        output: results.join('\n') + (truncated ? '\n[结果已截断，仅显示前 50 条]' : ''),
        meta: { type: 'grep', matchCount: totalMatches, fileCount: matchedFiles },
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

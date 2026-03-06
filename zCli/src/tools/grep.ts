// src/tools/grep.ts
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
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
    const searchPath = resolve(ctx.cwd, String(args['path'] ?? ctx.cwd))
    const recursive = args['recursive'] !== false

    try {
      const regex = new RegExp(pattern, 'gi')
      let files: string[]

      const stat = statSync(searchPath, { throwIfNoEntry: false })
      if (stat?.isFile()) {
        files = [searchPath]
      } else {
        const glob = recursive ? '**/*' : '*'
        files = await fg(glob, { cwd: searchPath, dot: false, onlyFiles: true, absolute: true })
      }

      const results: string[] = []
      for (const file of files) {
        if (results.length >= MAX_RESULTS) break
        try {
          const lines = readFileSync(file, 'utf-8').split('\n')
          lines.forEach((line, i) => {
            if (regex.test(line) && results.length < MAX_RESULTS) {
              results.push(`${file}:${i + 1}: ${line}`)
            }
            regex.lastIndex = 0
          })
        } catch { /* 跳过无法读取的文件 */ }
      }

      if (results.length === 0) return { success: true, output: 'No matches found.' }
      const truncated = results.length >= MAX_RESULTS
      return {
        success: true,
        output: results.join('\n') + (truncated ? '\n[结果已截断，仅显示前 50 条]' : ''),
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

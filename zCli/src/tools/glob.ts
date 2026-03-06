// src/tools/glob.ts
import fg from 'fast-glob'
import type { Tool, ToolContext, ToolResult } from './types.js'

export class GlobTool implements Tool {
  readonly name = 'glob'
  readonly dangerous = false
  readonly description = '按 glob 模式匹配文件路径，返回匹配的文件列表。'
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
      cwd: { type: 'string', description: '搜索根目录，默认为当前工作目录' },
    },
    required: ['pattern'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args['pattern'] ?? '')
    const cwd = String(args['cwd'] ?? ctx.cwd)

    try {
      const files = await fg(pattern, { cwd, dot: false, onlyFiles: true })
      if (files.length === 0) {
        return { success: true, output: 'No files matched the pattern.' }
      }
      return { success: true, output: files.join('\n') }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// src/tools/glob.ts
import fg from 'fast-glob'
import type { Tool, ToolContext, ToolResult } from './types.js'

export class GlobTool implements Tool {
  readonly name = 'glob'
  readonly dangerous = false
  readonly description = [
    '按 glob 模式匹配文件路径，返回匹配的文件列表。用于查找文件位置。',
    '',
    '常用模式：',
    '• **/*.ts — 递归查找所有 TypeScript 文件',
    '• src/**/*.test.ts — 查找 src 下所有测试文件',
    '• *.json — 当前目录下的 JSON 文件',
    '',
    '注意事项：',
    '• 自动排除隐藏文件（以 . 开头），不扫描 node_modules',
    '• 搜索文件名用 glob，搜索文件内容用 grep',
  ].join('\n')
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（如 **/*.ts、src/**/*.vue）' },
      cwd: { type: 'string', description: '搜索根目录（默认当前工作目录）' },
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
      return { success: true, output: files.join('\n'), meta: { type: 'glob', fileCount: files.length } }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

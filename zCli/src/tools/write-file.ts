// src/tools/write-file.ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.js'

export class WriteFileTool implements Tool {
  readonly name = 'write_file'
  readonly dangerous = true
  readonly description = '将内容写入文件（覆盖）。自动创建父目录。'
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径）' },
      content: { type: 'string', description: '写入内容' },
    },
    required: ['path', 'content'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args['path'] ?? '')
    const path = resolve(ctx.cwd, rawPath)
    const content = String(args['content'] ?? '')

    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true, output: `已写入 ${path}（${content.length} 字符）` }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

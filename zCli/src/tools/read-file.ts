// src/tools/read-file.ts
import { readFile } from 'node:fs/promises'
import { resolvePath } from '@platform/path-utils.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

const MAX_CHARS = 20_000

export class ReadFileTool implements Tool {
  readonly name = 'read_file'
  readonly dangerous = false
  readonly description = '读取文件内容。path 为绝对路径或相对于 cwd 的相对路径。'
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args['path'] ?? '')
    const filePath = resolvePath(ctx.cwd, rawPath)

    try {
      let content = await readFile(filePath, 'utf-8')
      let truncated = false
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS)
        truncated = true
      }
      return {
        success: true,
        output: truncated ? content + '\n\n[内容已截断]' : content,
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, output: '', error: `文件不存在: ${filePath}` }
      }
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

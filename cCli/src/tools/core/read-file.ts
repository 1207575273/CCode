// src/tools/read-file.ts
import { readFile } from 'node:fs/promises'
import { resolvePath } from '@platform/path-utils.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

const MAX_CHARS = 20_000

export class ReadFileTool implements Tool {
  readonly name = 'read_file'
  readonly dangerous = false
  readonly description = [
    '读取文件内容，返回带行号的文本。',
    '',
    '注意事项：',
    '• 支持绝对路径或相对于 cwd 的相对路径',
    '• 超过 20000 字符会自动截断，截断时请用 grep 定位后再读取特定区域',
    '• 修改文件前必须先读取，了解现有内容后再用 edit_file 精确修改',
    '• 不确定文件路径时，先用 glob 或 grep 搜索确认',
  ].join('\n')
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
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
      const totalLines = content.split('\n').length
      return {
        success: true,
        output: truncated ? content + '\n\n[内容已截断]' : content,
        meta: { type: 'read', path: rawPath, totalLines },
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, output: '', error: `文件不存在: ${filePath}` }
      }
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

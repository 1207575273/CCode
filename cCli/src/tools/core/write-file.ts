// src/tools/write-file.ts
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePath } from '@platform/path-utils.js'
import type { Tool, ToolContext, ToolResult, ToolResultMeta } from './types.js'

export class WriteFileTool implements Tool {
  readonly name = 'write_file'
  readonly dangerous = true
  readonly description = [
    '创建新文件或完全覆盖已有文件，自动创建不存在的父目录。',
    '',
    '注意事项：',
    '• 此操作会覆盖文件全部内容，修改已有文件请优先使用 edit_file（只改需要改的部分）',
    '• 仅在创建新文件或需要完全重写时使用 write_file',
    '• 写入前确认路径正确，避免误覆盖重要文件',
    '• 支持绝对路径或相对于 cwd 的相对路径',
  ].join('\n')
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
      content: { type: 'string', description: '写入的完整文件内容' },
    },
    required: ['path', 'content'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args['path'] ?? '')
    const path = resolvePath(ctx.cwd, rawPath)
    const content = String(args['content'] ?? '')

    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')

      const lines = content.split('\n')
      return {
        success: true,
        // 反馈信息要足够明确，让弱模型也能确认"这一步已完成，该继续下一步了"
        output: `✅ 文件已成功写入，无需重复写入。路径: ${path}，${content.length} 字符 / ${lines.length} 行。请继续执行下一个步骤。`,
        meta: {
          type: 'write',
          path: rawPath,
          totalLines: lines.length,
          preview: lines.slice(0, 4).join('\n'),
        } satisfies ToolResultMeta,
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

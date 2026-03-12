// src/tools/edit-file.ts
import { readFile, writeFile } from 'node:fs/promises'
import { resolvePath } from '@platform/path-utils.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

export class EditFileTool implements Tool {
  readonly name = 'edit_file'
  readonly dangerous = true
  readonly description = '精确替换文件中的字符串。old_str 必须在文件中唯一存在，否则报错。'
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_str: { type: 'string', description: '要替换的原始字符串（必须唯一）' },
      new_str: { type: 'string', description: '替换后的新字符串' },
    },
    required: ['path', 'old_str', 'new_str'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args['path'] ?? '')
    const path = resolvePath(ctx.cwd, rawPath)
    const oldStr = String(args['old_str'] ?? '')
    const newStr = String(args['new_str'] ?? '')

    try {
      const content = await readFile(path, 'utf-8')
      const count = content.split(oldStr).length - 1

      if (count === 0) {
        return { success: false, output: '', error: `old_str not found in ${path}` }
      }
      if (count > 1) {
        return { success: false, output: '', error: `old_str 在文件中出现 ${count} 次，需保证唯一` }
      }

      const updated = content.replace(oldStr, newStr)
      await writeFile(path, updated, 'utf-8')
      return { success: true, output: `已替换 ${path}` }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// src/skills/engine/skill-tool.ts

/**
 * Skill 原子工具 — 注册到 ToolRegistry，供 LLM 按需调用加载 Skill 正文。
 *
 * LLM 在 system prompt 中看到 skills 列表后，自主判断何时调用此工具。
 * 调用 skill({ name: "commit" }) → 返回 SKILL.md 的完整正文。
 */

import type { Tool, ToolContext, ToolResult } from '@tools/types.js'
import type { SkillStore } from './store.js'

export class SkillTool implements Tool {
  readonly name = 'skill'
  readonly description =
    'Load a skill\'s full instructions by name. ' +
    'Use this when a task matches an available skill from the skills list in the system prompt.'
  readonly parameters = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to load (e.g. "commit")',
      },
    },
    required: ['name'],
  }
  readonly dangerous = false

  readonly #store: SkillStore

  constructor(store: SkillStore) {
    this.#store = store
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const name = args['name']
    if (typeof name !== 'string' || !name.trim()) {
      return { success: false, output: '', error: 'Missing required parameter: name' }
    }

    const trimmedName = name.trim()
    const content = await this.#store.getContent(trimmedName)
    if (!content) {
      const available = this.#store.getAll().map(s => s.name).join(', ')
      return {
        success: false,
        output: '',
        error: `Skill "${name}" not found. Available skills: ${available || 'none'}`,
      }
    }

    // 检查支撑文件，有则附加 <skill-context> 标签
    const supportingFiles = await this.#store.getSupportingFiles(trimmedName)
    if (supportingFiles.length > 0) {
      const fileList = supportingFiles.map(f => `- ${f}`).join('\n')
      const contextBlock = `<skill-context>\nSupporting files available in the skill directory:\n${fileList}\n</skill-context>\n\n`
      return { success: true, output: contextBlock + content }
    }

    return { success: true, output: content }
  }
}

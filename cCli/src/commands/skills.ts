// src/commands/skills.ts

/**
 * /skills 指令 — 列出可用 Skills 或手动加载指定 Skill。
 *
 * 用法：
 *   /skills          列出所有可用 skills
 *   /skills <name>   加载指定 skill 到当前对话上下文
 */

import type { Command, CommandResult } from '@commands/types.js'

export class SkillsCommand implements Command {
  readonly name = 'skills'
  readonly aliases = ['skill'] as const
  readonly description = 'List or load skills'

  execute(args: string[]): CommandResult {
    const skillName = args[0]?.trim()

    if (!skillName) {
      return { handled: true, action: { type: 'list_skills' } }
    }

    return { handled: true, action: { type: 'load_skill', name: skillName } }
  }
}

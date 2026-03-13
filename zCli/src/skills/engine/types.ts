// src/skills/engine/types.ts

/** Skill 元数据，从 SKILL.md frontmatter 中解析 */
export interface SkillMetadata {
  /** 唯一标识，小写+连字符 */
  name: string
  /** 触发条件描述，LLM 据此判断是否调用 */
  description: string
  /** SKILL.md 文件绝对路径 */
  filePath: string
  /** 来源层级 */
  source: 'builtin' | 'plugin' | 'user' | 'project'
  /** 插件包名称（仅 source='plugin' 时存在） */
  pluginName?: string
  /** 限制该 skill 可使用的工具列表 */
  allowedTools?: string[]
  /** 是否可通过 /skills 手动触发，默认 true */
  userInvocable?: boolean
}

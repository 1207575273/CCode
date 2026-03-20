// src/skills/engine/store.ts

/**
 * SkillStore — 文件系统 Skill 发现与管理。
 *
 * 四源扫描：内置(builtin) → 插件(plugin) → 用户级(user) → 项目级(project)
 * 同名 Skill 按优先级覆盖：project > user > plugin > builtin
 */

import { readFile } from 'node:fs/promises'
import { join, dirname, basename, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import { parseSkillFile, toSkillMetadata } from './parser.js'
import type { SkillMetadata } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 内置 skills 目录（相对于编译后的 dist 结构） */
function builtinSkillsDir(): string {
  // src/skills/engine/store.ts → src/skills/builtin/
  return join(__dirname, '..', 'builtin')
}

/** 用户级 skills 目录 */
function userSkillsDir(): string {
  return join(homedir(), '.ccode', 'skills')
}

/** 项目级 skills 目录 */
function projectSkillsDir(): string {
  return join(process.cwd(), '.ccode', 'skills')
}

/** 用户级插件目录 */
export function userPluginsDir(): string {
  return join(homedir(), '.ccode', 'plugins')
}

/** 项目级插件目录 */
export function projectPluginsDir(): string {
  return join(process.cwd(), '.ccode', 'plugins')
}

export class SkillStore {
  /** 已发现的 skills（按名称去重，高优先级覆盖） */
  #skills = new Map<string, SkillMetadata>()
  #discovered = false

  /** 是否已完成发现 */
  isDiscovered(): boolean { return this.#discovered }

  /** 已发现的插件目录列表 */
  #pluginDirs: string[] = []

  /**
   * 发现所有可用 skills，合并四层来源。
   * 幂等：多次调用只扫描一次。
   */
  async discover(): Promise<SkillMetadata[]> {
    if (this.#discovered) return [...this.#skills.values()]
    this.#discovered = true

    // 四源并行扫描，按优先级从低到高合并（后者覆盖前者）
    const [builtinSkills, pluginSkills, userSkills, projectSkills] = await Promise.all([
      this.#scanDir(builtinSkillsDir(), 'builtin'),
      this.#scanPlugins(),
      this.#scanDir(userSkillsDir(), 'user'),
      this.#scanDir(projectSkillsDir(), 'project'),
    ])

    for (const meta of [...builtinSkills, ...pluginSkills, ...userSkills, ...projectSkills]) {
      this.#skills.set(meta.name, meta)
    }

    return [...this.#skills.values()]
  }

  /** 获取所有已发现的 skill 元数据 */
  getAll(): SkillMetadata[] {
    return [...this.#skills.values()]
  }

  /** 获取单个 skill 元数据 */
  get(name: string): SkillMetadata | undefined {
    return this.#skills.get(name)
  }

  /** 获取已发现的插件目录列表（供 HookManager 使用） */
  getPluginDirs(): string[] {
    return [...this.#pluginDirs]
  }

  /** 获取指定 skill 的完整正文（去掉 frontmatter） */
  async getContent(name: string): Promise<string | null> {
    const meta = this.#skills.get(name)
    if (!meta) return null

    try {
      const raw = await readFile(meta.filePath, 'utf-8')
      const { body } = parseSkillFile(raw)
      return body
    } catch {
      return null
    }
  }

  /**
   * 获取指定 skill 的支撑文件列表（相对于 skill 目录）。
   * 排除 SKILL.md、隐藏文件、node_modules。
   */
  async getSupportingFiles(name: string): Promise<string[]> {
    const meta = this.#skills.get(name)
    if (!meta) return []

    try {
      const skillDir = dirname(meta.filePath)
      const pattern = skillDir.replace(/\\/g, '/') + '/**/*'
      const files = await fg(pattern, {
        absolute: true,
        dot: false,           // 排除隐藏文件
        ignore: ['**/node_modules/**'],
      })

      // 排除 SKILL.md 本身，返回相对路径
      return files
        .filter(f => basename(f) !== 'SKILL.md')
        .map(f => relative(skillDir, f).replace(/\\/g, '/'))
    } catch {
      return []
    }
  }

  /**
   * 生成 system prompt 中的 skills 列表段落（L1 层）。
   * 仅包含 name + description，不含正文。
   */
  buildSystemPromptSection(): string {
    const skills = this.getAll()
    if (skills.length === 0) return ''

    const lines = [
      '## Available Skills',
      '',
      'The following skills are available. Use the `skill` tool to load a skill\'s full instructions when relevant.',
      '',
    ]

    for (const s of skills) {
      lines.push(`- **${s.name}**: ${s.description}`)
    }

    lines.push('')
    lines.push('To use a skill, call the `skill` tool with the skill name. The tool will return the skill\'s full instructions.')

    return lines.join('\n')
  }

  /**
   * 扫描插件目录，发现所有插件包内的 skills。
   * 扫描路径：userPluginsDir() 和 projectPluginsDir() 下的 `<pluginName>/skills/`
   * 每个 skill 名自动加 `<pluginName>:` 命名空间前缀。
   */
  async #scanPlugins(): Promise<SkillMetadata[]> {
    const pluginRoots = [userPluginsDir(), projectPluginsDir()]
    const allSkills: SkillMetadata[] = []

    for (const root of pluginRoots) {
      try {
        // 发现插件目录：root/*/
        const pattern = root.replace(/\\/g, '/') + '/*/'
        const pluginDirs = await fg(pattern, { onlyDirectories: true, absolute: true })

        for (const pluginDir of pluginDirs) {
          const pluginName = basename(pluginDir)
          this.#pluginDirs.push(pluginDir)

          const skillsDir = join(pluginDir, 'skills')
          const skills = await this.#scanDir(skillsDir, 'plugin')

          // 给每个 skill 加命名空间前缀，设置 pluginName
          for (const skill of skills) {
            skill.name = `${pluginName}:${skill.name}`
            skill.pluginName = pluginName
          }

          allSkills.push(...skills)
        }
      } catch {
        // 插件目录不存在，跳过
      }
    }

    return allSkills
  }

  /** 扫描指定目录下的 SKILL.md 文件，并行读取所有文件 */
  async #scanDir(dir: string, source: SkillMetadata['source']): Promise<SkillMetadata[]> {
    try {
      // fast-glob 需要 posix 路径（Windows 反斜杠 → 正斜杠）
      const pattern = dir.replace(/\\/g, '/') + '/*/SKILL.md'
      const files = await fg(pattern, { absolute: true })

      // 并行读取 + 解析所有 SKILL.md
      const results = await Promise.all(
        files.map(async (filePath) => {
          try {
            const raw = await readFile(filePath, 'utf-8')
            const { frontmatter } = parseSkillFile(raw)
            return toSkillMetadata(frontmatter, filePath, source)
          } catch {
            return null
          }
        }),
      )

      return results.filter((m): m is SkillMetadata => m !== null)
    } catch {
      // 目录不存在，正常情况
      return []
    }
  }
}

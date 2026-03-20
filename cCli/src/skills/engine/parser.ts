// src/skills/engine/parser.ts

/**
 * SKILL.md 解析器 — 提取 YAML frontmatter + Markdown body。
 *
 * 不依赖外部 YAML 库，手写简易解析（参考 superpowers skills-core.js）。
 * 仅支持 skill 场景的简单 key: value 格式。
 */

import type { SkillMetadata } from './types.js'

/** frontmatter 解析结果 */
interface ParsedSkill {
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * 解析 SKILL.md 内容：提取 --- 包裹的 frontmatter 和正文。
 * frontmatter 不存在时返回空对象。
 */
export function parseSkillFile(content: string): ParsedSkill {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content }
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return { frontmatter: {}, body: content }
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 3).trimStart()
  const frontmatter = parseSimpleYaml(yamlBlock)

  return { frontmatter, body }
}

/**
 * 简易 YAML 解析：支持 key: value 和 key:\n  - item 两种格式。
 * 覆盖 skill frontmatter 的典型用法，不追求完整 YAML 规范。
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n').map(l => l.replace(/\r$/, ''))

  let currentKey = ''
  let currentList: string[] | null = null

  for (const line of lines) {
    // 列表项：  - value
    const listMatch = line.match(/^\s+-\s+(.+)$/)
    if (listMatch && currentKey) {
      if (!currentList) currentList = []
      currentList.push(listMatch[1]!.trim())
      continue
    }

    // 如果之前在收集列表，flush 掉
    if (currentList && currentKey) {
      result[currentKey] = currentList
      currentList = null
      currentKey = ''
    }

    // key: value
    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      const key = kvMatch[1]!
      const value = kvMatch[2]!.trim()

      if (value === '' || value === '|' || value === '>') {
        // 可能是列表或多行值的开头
        currentKey = key
        continue
      }

      // 布尔值
      if (value === 'true') { result[key] = true; continue }
      if (value === 'false') { result[key] = false; continue }

      // 字符串值（去掉成对的首尾引号）
      const unquoted = value.match(/^(["'])(.+)\1$/)
      result[key] = unquoted ? unquoted[2]! : value
      currentKey = ''
    }
  }

  // flush 尾部列表
  if (currentList && currentKey) {
    result[currentKey] = currentList
  }

  return result
}

/**
 * 将 frontmatter 转换为 SkillMetadata。
 * 校验必填字段，不合法返回 null。
 */
export function toSkillMetadata(
  frontmatter: Record<string, unknown>,
  filePath: string,
  source: SkillMetadata['source'],
): SkillMetadata | null {
  const name = frontmatter['name']
  const description = frontmatter['description']

  if (typeof name !== 'string' || !name.trim()) return null
  if (typeof description !== 'string' || !description.trim()) return null

  const meta: SkillMetadata = {
    name: name.trim(),
    description: description.trim(),
    filePath,
    source,
  }

  // allowed-tools: 支持数组或逗号分隔字符串
  const allowedTools = frontmatter['allowed-tools'] ?? frontmatter['allowedTools']
  if (Array.isArray(allowedTools)) {
    meta.allowedTools = allowedTools.map(String)
  } else if (typeof allowedTools === 'string') {
    meta.allowedTools = allowedTools.split(',').map(s => s.trim()).filter(Boolean)
  }

  // user-invocable
  const userInvocable = frontmatter['user-invocable'] ?? frontmatter['userInvocable']
  if (typeof userInvocable === 'boolean') {
    meta.userInvocable = userInvocable
  }

  return meta
}

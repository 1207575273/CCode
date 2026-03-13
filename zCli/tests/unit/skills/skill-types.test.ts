// tests/unit/skills/skill-types.test.ts

import { describe, it, expect } from 'vitest'
import type { SkillMetadata } from '@skills/engine/types.js'

describe('SkillMetadata 类型', () => {
  it('should_support_plugin_source', () => {
    const meta: SkillMetadata = {
      name: 'superpowers:brainstorming',
      description: '头脑风暴插件',
      filePath: '/path/to/SKILL.md',
      source: 'plugin',
      pluginName: 'superpowers',
    }

    expect(meta.source).toBe('plugin')
    expect(meta.pluginName).toBe('superpowers')
  })

  it('should_support_all_source_types', () => {
    const sources: SkillMetadata['source'][] = ['builtin', 'plugin', 'user', 'project']

    for (const source of sources) {
      const meta: SkillMetadata = {
        name: `test-${source}`,
        description: `${source} skill`,
        filePath: '/path/to/SKILL.md',
        source,
      }
      expect(meta.source).toBe(source)
    }
  })

  it('should_allow_omitting_pluginName', () => {
    const meta: SkillMetadata = {
      name: 'commit',
      description: '提交代码',
      filePath: '/path/to/SKILL.md',
      source: 'builtin',
    }

    expect(meta.pluginName).toBeUndefined()
  })

  it('should_include_pluginName_for_plugin_source', () => {
    const meta: SkillMetadata = {
      name: 'my-plugin:my-skill',
      description: '插件 skill',
      filePath: '/home/.zcli/plugins/my-plugin/skills/my-skill/SKILL.md',
      source: 'plugin',
      pluginName: 'my-plugin',
    }

    expect(meta.name).toBe('my-plugin:my-skill')
    expect(meta.pluginName).toBe('my-plugin')
    expect(meta.source).toBe('plugin')
  })
})

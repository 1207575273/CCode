// tests/unit/skills/skill-store-plugins.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

// mock fast-glob 和 readFile
vi.mock('fast-glob', () => ({ default: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { SkillStore } from '@skills/engine/store.js'

const mockedFg = vi.mocked(fg)
const mockedReadFile = vi.mocked(readFile)

/** 构造 SKILL.md 内容 */
function makeSkillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill body for ${name}.`
}

/**
 * 根据 fast-glob 的 pattern 参数返回不同结果。
 * 关键识别规则：
 * - 包含 'builtin' → 内置 skills
 * - 包含 'plugins' + onlyDirectories → 插件目录发现
 * - 包含 'plugins' + 'SKILL.md' → 插件内 skill 文件
 * - 包含 '.zcli/skills' → user/project skills
 */
function setupFgMock(config: {
  builtinFiles?: string[]
  userSkillFiles?: string[]
  projectSkillFiles?: string[]
  userPluginDirs?: string[]
  projectPluginDirs?: string[]
  pluginSkillFiles?: Record<string, string[]>  // pluginDir → skill files
}): void {
  mockedFg.mockImplementation(async (pattern: string | string[], options?: Record<string, unknown>) => {
    const p = Array.isArray(pattern) ? pattern[0]! : pattern
    const isOnlyDirs = options?.['onlyDirectories'] === true

    // 插件目录发现
    if (isOnlyDirs && p.includes('plugins')) {
      if (p.includes(homedir().replace(/\\/g, '/'))) {
        return config.userPluginDirs ?? []
      }
      return config.projectPluginDirs ?? []
    }

    // 内置 skills
    if (p.includes('builtin')) {
      return config.builtinFiles ?? []
    }

    // 插件内 skill 文件
    if (p.includes('plugins') && p.includes('SKILL.md')) {
      for (const [dir, files] of Object.entries(config.pluginSkillFiles ?? {})) {
        if (p.startsWith(dir.replace(/\\/g, '/'))) {
          return files
        }
      }
      return []
    }

    // 用户级 skills
    if (p.includes('.zcli/skills') && p.includes(homedir().replace(/\\/g, '/'))) {
      return config.userSkillFiles ?? []
    }

    // 项目级 skills
    if (p.includes('.zcli/skills')) {
      return config.projectSkillFiles ?? []
    }

    return []
  })
}

describe('SkillStore 插件扫描', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should_discover_plugin_skills_with_namespace', async () => {
    const pluginDir = join(homedir(), '.zcli', 'plugins', 'superpowers')
    const skillFile = join(pluginDir, 'skills', 'brainstorming', 'SKILL.md')

    setupFgMock({
      userPluginDirs: [pluginDir],
      pluginSkillFiles: {
        [join(pluginDir, 'skills')]: [skillFile],
      },
    })

    mockedReadFile.mockImplementation(async (path) => {
      if (String(path) === skillFile) {
        return makeSkillMd('brainstorming', '头脑风暴技巧')
      }
      throw new Error('File not found')
    })

    const store = new SkillStore()
    const skills = await store.discover()

    const skill = skills.find(s => s.name === 'superpowers:brainstorming')
    expect(skill).toBeDefined()
    expect(skill!.source).toBe('plugin')
    expect(skill!.pluginName).toBe('superpowers')
    expect(skill!.description).toBe('头脑风暴技巧')
  })

  it('should_support_multiple_plugins_with_independent_namespaces', async () => {
    const plugin1Dir = join(homedir(), '.zcli', 'plugins', 'alpha')
    const plugin2Dir = join(homedir(), '.zcli', 'plugins', 'beta')
    const skill1File = join(plugin1Dir, 'skills', 'task-a', 'SKILL.md')
    const skill2File = join(plugin2Dir, 'skills', 'task-b', 'SKILL.md')

    setupFgMock({
      userPluginDirs: [plugin1Dir, plugin2Dir],
      pluginSkillFiles: {
        [join(plugin1Dir, 'skills')]: [skill1File],
        [join(plugin2Dir, 'skills')]: [skill2File],
      },
    })

    mockedReadFile.mockImplementation(async (path) => {
      const p = String(path)
      if (p === skill1File) return makeSkillMd('task-a', 'Alpha 任务 A')
      if (p === skill2File) return makeSkillMd('task-b', 'Beta 任务 B')
      throw new Error('File not found')
    })

    const store = new SkillStore()
    const skills = await store.discover()

    expect(skills.find(s => s.name === 'alpha:task-a')).toBeDefined()
    expect(skills.find(s => s.name === 'beta:task-b')).toBeDefined()
    expect(skills.find(s => s.name === 'alpha:task-a')!.pluginName).toBe('alpha')
    expect(skills.find(s => s.name === 'beta:task-b')!.pluginName).toBe('beta')
  })

  it('should_not_conflict_between_plugin_and_user_skills_with_same_base_name', async () => {
    const pluginDir = join(homedir(), '.zcli', 'plugins', 'myplugin')
    const pluginSkillFile = join(pluginDir, 'skills', 'deploy', 'SKILL.md')
    const userSkillFile = join(homedir(), '.zcli', 'skills', 'deploy', 'SKILL.md')

    setupFgMock({
      userPluginDirs: [pluginDir],
      pluginSkillFiles: {
        [join(pluginDir, 'skills')]: [pluginSkillFile],
      },
      userSkillFiles: [userSkillFile],
    })

    mockedReadFile.mockImplementation(async (path) => {
      const p = String(path)
      if (p === pluginSkillFile) return makeSkillMd('deploy', '插件版部署')
      if (p === userSkillFile) return makeSkillMd('deploy', '用户版部署')
      throw new Error('File not found')
    })

    const store = new SkillStore()
    const skills = await store.discover()

    // 两个都应该存在，名字不同（一个有前缀，一个没有）
    const pluginSkill = skills.find(s => s.name === 'myplugin:deploy')
    const userSkill = skills.find(s => s.name === 'deploy')

    expect(pluginSkill).toBeDefined()
    expect(pluginSkill!.source).toBe('plugin')
    expect(userSkill).toBeDefined()
    expect(userSkill!.source).toBe('user')
  })

  it('should_handle_empty_plugin_directory_gracefully', async () => {
    const pluginDir = join(homedir(), '.zcli', 'plugins', 'empty-plugin')

    setupFgMock({
      userPluginDirs: [pluginDir],
      pluginSkillFiles: {
        [join(pluginDir, 'skills')]: [],
      },
    })

    const store = new SkillStore()
    const skills = await store.discover()

    // 不报错，返回空
    expect(skills).toEqual([])
  })

  it('should_return_correct_plugin_dirs_from_getPluginDirs', async () => {
    const plugin1 = join(homedir(), '.zcli', 'plugins', 'plugin-a')
    const plugin2 = join(homedir(), '.zcli', 'plugins', 'plugin-b')

    setupFgMock({
      userPluginDirs: [plugin1, plugin2],
      pluginSkillFiles: {
        [join(plugin1, 'skills')]: [],
        [join(plugin2, 'skills')]: [],
      },
    })

    const store = new SkillStore()
    await store.discover()

    const dirs = store.getPluginDirs()
    expect(dirs).toContain(plugin1)
    expect(dirs).toContain(plugin2)
    expect(dirs).toHaveLength(2)
  })

  it('should_get_single_skill_by_name', async () => {
    const pluginDir = join(homedir(), '.zcli', 'plugins', 'test-plugin')
    const skillFile = join(pluginDir, 'skills', 'my-skill', 'SKILL.md')

    setupFgMock({
      userPluginDirs: [pluginDir],
      pluginSkillFiles: {
        [join(pluginDir, 'skills')]: [skillFile],
      },
    })

    mockedReadFile.mockImplementation(async (path) => {
      if (String(path) === skillFile) return makeSkillMd('my-skill', '测试 skill')
      throw new Error('File not found')
    })

    const store = new SkillStore()
    await store.discover()

    const skill = store.get('test-plugin:my-skill')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('test-plugin:my-skill')

    // 不存在的名字
    expect(store.get('nonexistent')).toBeUndefined()
  })
})

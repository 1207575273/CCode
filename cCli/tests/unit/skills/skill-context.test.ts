// tests/unit/skills/skill-context.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock fast-glob 和 readFile
vi.mock('fast-glob', () => ({ default: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { SkillStore } from '@skills/engine/store.js'
import { SkillTool } from '@skills/engine/skill-tool.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const mockedFg = vi.mocked(fg)
const mockedReadFile = vi.mocked(readFile)

const SKILL_DIR = join(homedir(), '.ccode', 'skills', 'code-review')
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')
const SKILL_MD_CONTENT = `---
name: code-review
description: 代码审查
---

# Code Review

审查步骤说明。`

/**
 * 设置 fg mock：
 * - 扫描 skills 目录 → 返回 skill 文件
 * - 扫描 skill 子目录（支撑文件）→ 根据参数返回
 */
function setupMocks(supportingFiles: string[]): void {
  mockedFg.mockImplementation(async (pattern: string | string[], options?: Record<string, unknown>) => {
    const p = Array.isArray(pattern) ? pattern[0]! : pattern
    const isOnlyDirs = options?.['onlyDirectories'] === true

    // 插件目录发现 → 空
    if (isOnlyDirs) return []

    // skills 目录扫描（发现 SKILL.md）
    if (p.endsWith('/*/SKILL.md')) {
      // 只有 user skills 目录会返回文件
      if (p.includes('.ccode/skills')) {
        return [SKILL_FILE]
      }
      return []
    }

    // 支撑文件扫描（skill 子目录的 **/*）
    if (p.includes('code-review') && p.endsWith('/**/*')) {
      return supportingFiles
    }

    return []
  })

  mockedReadFile.mockImplementation(async (path) => {
    if (String(path) === SKILL_FILE) return SKILL_MD_CONTENT
    throw new Error('File not found')
  })
}

describe('Skill 支撑文件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('SkillStore.getSupportingFiles', () => {
    it('should_return_supporting_files_excluding_SKILL_md', async () => {
      const checklist = join(SKILL_DIR, 'checklist.md')
      const template = join(SKILL_DIR, 'templates', 'review.txt')
      setupMocks([SKILL_FILE, checklist, template])

      const store = new SkillStore()
      await store.discover()

      const files = await store.getSupportingFiles('code-review')
      expect(files).toContain('checklist.md')
      expect(files).toContain('templates/review.txt')
      expect(files).not.toContain('SKILL.md')
    })

    it('should_return_empty_when_no_supporting_files', async () => {
      setupMocks([SKILL_FILE]) // 只有 SKILL.md

      const store = new SkillStore()
      await store.discover()

      const files = await store.getSupportingFiles('code-review')
      expect(files).toEqual([])
    })

    it('should_exclude_hidden_files_via_dot_option', async () => {
      // fast-glob 的 dot: false 会排除隐藏文件
      // 这里验证调用 fg 时传入了正确的选项
      setupMocks([])

      const store = new SkillStore()
      await store.discover()

      await store.getSupportingFiles('code-review')

      // 找到支撑文件扫描的调用（pattern 包含 **/*）
      const supportCall = mockedFg.mock.calls.find(
        call => String(call[0]).includes('/**/*'),
      )
      expect(supportCall).toBeDefined()
      const options = supportCall![1] as Record<string, unknown>
      expect(options['dot']).toBe(false)
      expect(options['ignore']).toContain('**/node_modules/**')
    })

    it('should_return_empty_for_nonexistent_skill', async () => {
      setupMocks([])

      const store = new SkillStore()
      await store.discover()

      const files = await store.getSupportingFiles('nonexistent')
      expect(files).toEqual([])
    })
  })

  describe('SkillTool 支撑文件集成', () => {
    it('should_include_skill_context_tag_when_supporting_files_exist', async () => {
      const checklist = join(SKILL_DIR, 'checklist.md')
      setupMocks([SKILL_FILE, checklist])

      const store = new SkillStore()
      await store.discover()
      const tool = new SkillTool(store)

      const result = await tool.execute({ name: 'code-review' }, { cwd: process.cwd() })
      expect(result.success).toBe(true)
      expect(result.output).toContain('<skill-context>')
      expect(result.output).toContain('checklist.md')
      expect(result.output).toContain('</skill-context>')
      // body 部分仍然存在
      expect(result.output).toContain('审查步骤说明')
    })

    it('should_not_include_skill_context_tag_when_no_supporting_files', async () => {
      setupMocks([SKILL_FILE]) // 只有 SKILL.md，无支撑文件

      const store = new SkillStore()
      await store.discover()
      const tool = new SkillTool(store)

      const result = await tool.execute({ name: 'code-review' }, { cwd: process.cwd() })
      expect(result.success).toBe(true)
      expect(result.output).not.toContain('<skill-context>')
      expect(result.output).toContain('审查步骤说明')
    })
  })
})

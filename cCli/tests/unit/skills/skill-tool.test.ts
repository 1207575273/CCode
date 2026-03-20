// tests/unit/skills/skill-tool.test.ts

import { describe, it, expect, beforeAll } from 'vitest'
import { SkillStore } from '@skills/engine/store.js'
import { SkillTool } from '@skills/engine/skill-tool.js'

describe('SkillTool', () => {
  let store: SkillStore
  let tool: SkillTool

  beforeAll(async () => {
    store = new SkillStore()
    await store.discover()
    tool = new SkillTool(store)
  })

  it('should_have_correct_tool_metadata', () => {
    expect(tool.name).toBe('skill')
    expect(tool.description).toContain('Load a skill')
    expect(tool.dangerous).toBe(false)
    expect(tool.parameters).toHaveProperty('properties')
    expect(tool.parameters).toHaveProperty('required')
  })

  it('should_load_existing_skill_content', async () => {
    const result = await tool.execute({ name: 'commit' }, { cwd: process.cwd() })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Conventional Commits')
  })

  it('should_return_error_for_nonexistent_skill', async () => {
    const result = await tool.execute({ name: 'nonexistent-xyz' }, { cwd: process.cwd() })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
    expect(result.error).toContain('commit') // 应该列出可用 skills
  })

  it('should_return_error_for_missing_name', async () => {
    const result = await tool.execute({}, { cwd: process.cwd() })
    expect(result.success).toBe(false)
    expect(result.error).toContain('name')
  })

  it('should_return_error_for_empty_name', async () => {
    const result = await tool.execute({ name: '' }, { cwd: process.cwd() })
    expect(result.success).toBe(false)
    expect(result.error).toContain('name')
  })
})

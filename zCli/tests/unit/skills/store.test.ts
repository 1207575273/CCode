// tests/unit/skills/store.test.ts

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SkillStore } from '@core/skills/store.js'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SkillStore', () => {
  const testDir = join(tmpdir(), `zcli-skills-test-${Date.now()}`)
  const skillDir = join(testDir, 'test-skill')
  const skillFile = join(skillDir, 'SKILL.md')

  beforeEach(() => {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, `---
name: test-skill
description: A test skill for unit tests
user-invocable: true
---

# Test Skill

This is a test skill body.
`)
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('should_discover_skills_from_directory', async () => {
    const store = new SkillStore()
    const skills = await store.discover()

    // 至少有内置的 commit 和 hello-world skill
    const commit = skills.find(s => s.name === 'commit')
    expect(commit).toBeDefined()
    expect(commit!.source).toBe('builtin')
    expect(commit!.description).toContain('commit')

    const hello = skills.find(s => s.name === 'hello-world')
    expect(hello).toBeDefined()
    expect(hello!.source).toBe('builtin')

    const languages = skills.find(s => s.name === 'print-languages')
    expect(languages).toBeDefined()
    expect(languages!.source).toBe('builtin')
  })

  it('should_return_same_results_on_repeated_discover', async () => {
    const store = new SkillStore()
    const first = await store.discover()
    const second = await store.discover()
    expect(first).toEqual(second)
  })

  it('should_get_content_for_existing_skill', async () => {
    const store = new SkillStore()
    await store.discover()

    const content = await store.getContent('commit')
    expect(content).not.toBeNull()
    expect(content).toContain('Conventional Commits')
  })

  it('should_return_null_for_nonexistent_skill', async () => {
    const store = new SkillStore()
    await store.discover()

    const content = await store.getContent('nonexistent-skill-xyz')
    expect(content).toBeNull()
  })

  it('should_build_system_prompt_section', async () => {
    const store = new SkillStore()
    await store.discover()

    const section = store.buildSystemPromptSection()
    expect(section).toContain('## Available Skills')
    expect(section).toContain('commit')
    expect(section).toContain('skill')
  })

  it('should_return_empty_string_when_no_skills', () => {
    // 新 store 未 discover，getAll 返回空
    const store = new SkillStore()
    const section = store.buildSystemPromptSection()
    expect(section).toBe('')
  })
})

// tests/unit/skills/parser.test.ts

import { describe, it, expect } from 'vitest'
import { parseSkillFile, toSkillMetadata } from '@skills/engine/parser.js'

describe('parseSkillFile', () => {
  it('should_parse_frontmatter_and_body_when_valid_skill_md', () => {
    const content = `---
name: commit
description: Use when committing
allowed-tools: Bash
user-invocable: true
---

# Commit Skill

Some instructions here.`

    const result = parseSkillFile(content)
    expect(result.frontmatter['name']).toBe('commit')
    expect(result.frontmatter['description']).toBe('Use when committing')
    expect(result.frontmatter['allowed-tools']).toBe('Bash')
    expect(result.frontmatter['user-invocable']).toBe(true)
    expect(result.body).toContain('# Commit Skill')
    expect(result.body).toContain('Some instructions here.')
  })

  it('should_return_empty_frontmatter_when_no_yaml_block', () => {
    const content = '# Just a heading\n\nSome text'
    const result = parseSkillFile(content)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe(content)
  })

  it('should_return_empty_frontmatter_when_unclosed_yaml_block', () => {
    const content = '---\nname: broken\nno closing marker here'
    const result = parseSkillFile(content)
    expect(result.frontmatter).toEqual({})
  })

  it('should_parse_list_values_in_frontmatter', () => {
    const content = `---
name: test
description: A test skill
allowed-tools:
  - Bash
  - Read
  - Edit
---

Body`

    const result = parseSkillFile(content)
    expect(result.frontmatter['allowed-tools']).toEqual(['Bash', 'Read', 'Edit'])
  })

  it('should_parse_boolean_false_correctly', () => {
    const content = `---
name: hidden
description: Not visible
user-invocable: false
---

Body`

    const result = parseSkillFile(content)
    expect(result.frontmatter['user-invocable']).toBe(false)
  })

  it('should_strip_quotes_from_string_values', () => {
    const content = `---
name: "quoted-name"
description: 'single quoted'
---

Body`

    const result = parseSkillFile(content)
    expect(result.frontmatter['name']).toBe('quoted-name')
    expect(result.frontmatter['description']).toBe('single quoted')
  })
})

describe('toSkillMetadata', () => {
  it('should_convert_valid_frontmatter_to_metadata', () => {
    const fm = {
      name: 'commit',
      description: 'Use when committing',
      'allowed-tools': 'Bash, Read',
      'user-invocable': true,
    }
    const meta = toSkillMetadata(fm, '/path/to/SKILL.md', 'builtin')
    expect(meta).not.toBeNull()
    expect(meta!.name).toBe('commit')
    expect(meta!.description).toBe('Use when committing')
    expect(meta!.filePath).toBe('/path/to/SKILL.md')
    expect(meta!.source).toBe('builtin')
    expect(meta!.allowedTools).toEqual(['Bash', 'Read'])
    expect(meta!.userInvocable).toBe(true)
  })

  it('should_return_null_when_name_missing', () => {
    const meta = toSkillMetadata({ description: 'test' }, '/path', 'builtin')
    expect(meta).toBeNull()
  })

  it('should_return_null_when_description_missing', () => {
    const meta = toSkillMetadata({ name: 'test' }, '/path', 'builtin')
    expect(meta).toBeNull()
  })

  it('should_handle_array_allowed_tools', () => {
    const fm = {
      name: 'test',
      description: 'desc',
      'allowed-tools': ['Bash', 'Read'],
    }
    const meta = toSkillMetadata(fm, '/path', 'user')
    expect(meta!.allowedTools).toEqual(['Bash', 'Read'])
  })

  it('should_handle_missing_optional_fields', () => {
    const fm = { name: 'minimal', description: 'Minimal skill' }
    const meta = toSkillMetadata(fm, '/path', 'project')
    expect(meta).not.toBeNull()
    expect(meta!.allowedTools).toBeUndefined()
    expect(meta!.userInvocable).toBeUndefined()
  })
})

import { describe, it, expect } from 'vitest'
import {
  toProjectSlug,
  generateSessionId,
  generateEventId,
  formatSessionFilename,
  extractSessionId,
  getGitBranch,
} from '@persistence/session-utils.js'

describe('toProjectSlug', () => {
  it('should convert Windows path', () => {
    expect(toProjectSlug('D:\\a_dev_work\\claude_cli_z01')).toBe('D--a_dev_work-claude_cli_z01')
  })
  it('should convert Unix path', () => {
    expect(toProjectSlug('/home/user/project')).toBe('-home-user-project')
  })
  it('should handle trailing separator', () => {
    expect(toProjectSlug('D:\\a_dev_work\\')).toBe('D--a_dev_work-')
  })
})

describe('generateSessionId', () => {
  it('should return valid UUIDv7 format', () => {
    const id = generateSessionId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('should be monotonically increasing', () => {
    const a = generateSessionId()
    const b = generateSessionId()
    expect(a < b || a === b).toBe(true)
  })
})

describe('generateEventId', () => {
  it('should return valid UUIDv4 format', () => {
    const id = generateEventId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('formatSessionFilename', () => {
  it('should produce YYYYMMDDHHMMSSMMM_uuid.jsonl format', () => {
    const name = formatSessionFilename('019cd2c4-6d55-74e8-9966-990e9feb1e5a', new Date('2026-03-09T15:30:22.317Z'))
    expect(name).toBe('20260309153022317_019cd2c4-6d55-74e8-9966-990e9feb1e5a.jsonl')
  })
})

describe('extractSessionId', () => {
  it('should extract uuid from filename', () => {
    expect(extractSessionId('20260309153022317_019cd2c4-6d55-74e8-9966-990e9feb1e5a.jsonl'))
      .toBe('019cd2c4-6d55-74e8-9966-990e9feb1e5a')
  })
  it('should handle plain uuid.jsonl fallback', () => {
    expect(extractSessionId('some-id.jsonl')).toBe('some-id')
  })
})

describe('getGitBranch', () => {
  it('should return current branch name for a valid git repo', () => {
    const branch = getGitBranch(process.cwd())
    expect(typeof branch).toBe('string')
    expect(branch.length).toBeGreaterThan(0)
    expect(branch).not.toBe('unknown')
  })
  it('should return unknown for non-git directory', () => {
    const branch = getGitBranch('/nonexistent-path-that-does-not-exist')
    expect(branch).toBe('unknown')
  })
})

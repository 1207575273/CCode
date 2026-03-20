import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PermissionManager } from '@config/permissions.js'

// 模拟实际注册的工具名列表
const REGISTERED_TOOLS = [
  'bash', 'read_file', 'write_file', 'edit_file',
  'glob', 'grep', 'dispatch_agent',
]

describe('PermissionManager', () => {
  describe('规则匹配', () => {
    it('Bash(*) 匹配 bash 工具', () => {
      const pm = new PermissionManager(['Bash(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(true)
      expect(pm.isAllowed('read_file')).toBe(false)
    })

    it('Read(*) 匹配 read_file 工具（前缀推导）', () => {
      const pm = new PermissionManager(['Read(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('read_file')).toBe(true)
      expect(pm.isAllowed('write_file')).toBe(false)
    })

    it('Write(*) 匹配 write_file 工具', () => {
      const pm = new PermissionManager(['Write(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('write_file')).toBe(true)
    })

    it('Edit(*) 匹配 edit_file 工具', () => {
      const pm = new PermissionManager(['Edit(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('edit_file')).toBe(true)
    })

    it('Glob(*) 匹配 glob 工具', () => {
      const pm = new PermissionManager(['Glob(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('glob')).toBe(true)
    })

    it('Grep(*) 匹配 grep 工具', () => {
      const pm = new PermissionManager(['Grep(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('grep')).toBe(true)
    })

    it('不存在的友好名规则被忽略，不影响其他规则', () => {
      const pm = new PermissionManager(['FooBar(*)', 'Bash(*)'], REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(true)
      expect(pm.isAllowed('foobar')).toBe(false)
    })

    it('mcp__* 匹配所有 MCP 工具', () => {
      const pm = new PermissionManager(['mcp__*'], REGISTERED_TOOLS)
      expect(pm.isAllowed('mcp__server1__tool1')).toBe(true)
      expect(pm.isAllowed('mcp__context7__query')).toBe(true)
      expect(pm.isAllowed('bash')).toBe(false)
    })

    it('精确 MCP 规则匹配特定工具', () => {
      const pm = new PermissionManager(['mcp__context7__query-docs'], REGISTERED_TOOLS)
      expect(pm.isAllowed('mcp__context7__query-docs')).toBe(true)
      expect(pm.isAllowed('mcp__context7__resolve-library-id')).toBe(false)
    })

    it('直接使用内部工具名精确匹配', () => {
      const pm = new PermissionManager(['bash'], REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(true)
      expect(pm.isAllowed('write_file')).toBe(false)
    })

    it('多条规则组合', () => {
      const pm = new PermissionManager(['Bash(*)', 'Read(*)', 'mcp__*'], REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(true)
      expect(pm.isAllowed('read_file')).toBe(true)
      expect(pm.isAllowed('mcp__any__tool')).toBe(true)
      expect(pm.isAllowed('write_file')).toBe(false)
    })

    it('空规则列表不匹配任何工具', () => {
      const pm = new PermissionManager([], REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(false)
      expect(pm.isAllowed('mcp__test')).toBe(false)
    })

    it('无注册工具时友好名规则被忽略', () => {
      const pm = new PermissionManager(['Bash(*)', 'Read(*)'], [])
      expect(pm.isAllowed('bash')).toBe(false)
      // 但精确匹配和通配符仍然生效
      const pm2 = new PermissionManager(['bash', 'mcp__*'], [])
      expect(pm2.isAllowed('bash')).toBe(true)
      expect(pm2.isAllowed('mcp__test')).toBe(true)
    })
  })

  describe('fromProjectDir', () => {
    const testDir = join(tmpdir(), `ccode-perm-test-${Date.now()}`)
    const zcliDir = join(testDir, '.ccode')
    const settingsPath = join(zcliDir, 'settings.local.json')

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true })
    })

    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true })
    })

    it('settings.local.json 不存在时返回空白名单', () => {
      mkdirSync(testDir, { recursive: true })
      const pm = PermissionManager.fromProjectDir(testDir, REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(false)
    })

    it('settings.local.json 存在时加载规则', () => {
      mkdirSync(zcliDir, { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Bash(*)', 'Read(*)'] },
      }), 'utf-8')

      const pm = PermissionManager.fromProjectDir(testDir, REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(true)
      expect(pm.isAllowed('read_file')).toBe(true)
      expect(pm.isAllowed('write_file')).toBe(false)
    })

    it('settings.local.json JSON 损坏时返回空白名单', () => {
      mkdirSync(zcliDir, { recursive: true })
      writeFileSync(settingsPath, '{ broken', 'utf-8')

      const pm = PermissionManager.fromProjectDir(testDir, REGISTERED_TOOLS)
      expect(pm.isAllowed('bash')).toBe(false)
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, normalize, resolve } from 'node:path'
import { homedir } from 'node:os'

// 模拟 fs 和 child_process
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  findGitRoot,
  discoverInstructionFiles,
  loadInstructions,
  formatInstructionsPrompt,
} from '@config/instructions-loader.js'
import type { LoadedInstruction } from '@config/instructions-loader.js'

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>
const mockExecSync = execSync as ReturnType<typeof vi.fn>

// 使用 resolve 确保路径带驱动器前缀（Windows 兼容）
const FAKE_CWD = normalize(resolve('/fake/project'))
const FAKE_GIT_ROOT = normalize(resolve('/fake/project'))
const FAKE_HOME = homedir()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findGitRoot', () => {
  it('返回 git 仓库根目录', () => {
    mockExecSync.mockReturnValue('/fake/project\n')
    expect(findGitRoot(FAKE_CWD)).toBe(normalize('/fake/project'))
  })

  it('不在 git 仓库中返回 null', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    expect(findGitRoot(FAKE_CWD)).toBeNull()
  })
})

describe('discoverInstructionFiles', () => {
  it('发现全局 ZCLI.md（优先于 CLAUDE.md）', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => {
      return p === join(FAKE_HOME, '.zcli', 'ZCLI.md')
    })

    const files = discoverInstructionFiles(FAKE_CWD)
    expect(files).toContainEqual({
      path: normalize(resolve(join(FAKE_HOME, '.zcli', 'ZCLI.md'))),
      level: 'global',
    })
  })

  it('全局层 ZCLI.md 不存在时 fallback 到 CLAUDE.md', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => {
      return p === join(FAKE_HOME, '.claude', 'CLAUDE.md')
    })

    const files = discoverInstructionFiles(FAKE_CWD)
    expect(files).toContainEqual({
      path: normalize(resolve(join(FAKE_HOME, '.claude', 'CLAUDE.md'))),
      level: 'global',
    })
  })

  it('发现项目根 ZCLI.md', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => {
      return p === join(FAKE_GIT_ROOT, 'ZCLI.md')
    })

    const files = discoverInstructionFiles(FAKE_CWD)
    expect(files).toContainEqual({
      path: normalize(resolve(join(FAKE_GIT_ROOT, 'ZCLI.md'))),
      level: 'project',
    })
  })

  it('cwd == git-root 时不重复扫描层级 4', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => {
      return p === join(FAKE_GIT_ROOT, 'ZCLI.md')
    })

    const files = discoverInstructionFiles(FAKE_CWD)
    // 只有一条 project 级别的记录
    const projectFiles = files.filter(f => f.level === 'project' || f.level === 'cwd')
    expect(projectFiles).toHaveLength(1)
  })

  it('cwd != git-root 时扫描层级 4', () => {
    const subCwd = normalize(resolve('/fake/project/packages/web'))
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => {
      return p === join(subCwd, 'ZCLI.md')
    })

    const files = discoverInstructionFiles(subCwd)
    expect(files).toContainEqual({
      path: normalize(resolve(join(subCwd, 'ZCLI.md'))),
      level: 'cwd',
    })
  })

  it('同一文件路径不重复加载', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    // 全局和项目根恰好是同一个文件（不太可能但测试去重逻辑）
    const samePath = join(FAKE_GIT_ROOT, 'ZCLI.md')
    mockExistsSync.mockImplementation((p: string) => p === samePath)

    const files = discoverInstructionFiles(FAKE_CWD)
    const normalizedPaths = files.map(f => f.path)
    const uniquePaths = [...new Set(normalizedPaths)]
    expect(normalizedPaths).toEqual(uniquePaths)
  })

  it('不在 git 仓库中时以 cwd 作为项目根', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    mockExistsSync.mockImplementation((p: string) => {
      return p === join(FAKE_CWD, 'ZCLI.md')
    })

    const files = discoverInstructionFiles(FAKE_CWD)
    expect(files).toContainEqual({
      path: normalize(resolve(join(FAKE_CWD, 'ZCLI.md'))),
      level: 'project',
    })
  })
})

describe('loadInstructions', () => {
  it('加载文件内容', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    const filePath = join(FAKE_GIT_ROOT, 'ZCLI.md')
    mockExistsSync.mockImplementation((p: string) => p === filePath)
    mockReadFileSync.mockReturnValue('# 项目指令\n使用 TypeScript')

    const loaded = loadInstructions(FAKE_CWD)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.content).toBe('# 项目指令\n使用 TypeScript')
    expect(loaded[0]!.level).toBe('project')
  })

  it('空文件不加载', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => p === join(FAKE_GIT_ROOT, 'ZCLI.md'))
    mockReadFileSync.mockReturnValue('   \n  ')

    const loaded = loadInstructions(FAKE_CWD)
    expect(loaded).toHaveLength(0)
  })

  it('读取失败静默跳过', () => {
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT + '\n')
    mockExistsSync.mockImplementation((p: string) => p === join(FAKE_GIT_ROOT, 'ZCLI.md'))
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES') })

    const loaded = loadInstructions(FAKE_CWD)
    expect(loaded).toHaveLength(0)
  })
})

describe('formatInstructionsPrompt', () => {
  it('空数组返回空字符串', () => {
    expect(formatInstructionsPrompt([])).toBe('')
  })

  it('格式化为 <instructions> 标签', () => {
    const instructions: LoadedInstruction[] = [
      { source: '/home/.zcli/ZCLI.md', level: 'global', content: '全局指令' },
      { source: '/project/ZCLI.md', level: 'project', content: '项目指令' },
    ]

    const result = formatInstructionsPrompt(instructions)
    expect(result).toContain('<instructions source="/home/.zcli/ZCLI.md" level="global">')
    expect(result).toContain('全局指令')
    expect(result).toContain('</instructions>')
    expect(result).toContain('<instructions source="/project/ZCLI.md" level="project">')
    expect(result).toContain('项目指令')
  })

  it('多条指令用空行分隔', () => {
    const instructions: LoadedInstruction[] = [
      { source: 'a', level: 'global', content: 'aaa' },
      { source: 'b', level: 'project', content: 'bbb' },
    ]

    const result = formatInstructionsPrompt(instructions)
    expect(result).toContain('</instructions>\n\n<instructions')
  })
})

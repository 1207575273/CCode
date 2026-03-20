import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HookManager } from '../../../src/hooks/hook-manager.js'
import type { HookRunner, RunOptions } from '../../../src/hooks/hook-runner.js'

// Mock fs/promises 的 readFile
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

const mockedReadFile = vi.mocked(readFile)

/** 构造一个简单的 hooks.json 内容 */
function makeHooksJson(hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>) {
  return JSON.stringify({ hooks })
}

/** 创建一个 mock HookRunner */
function createMockRunner(returnValue: Record<string, unknown> | null = null): HookRunner {
  return {
    run: vi.fn<(opts: RunOptions) => Promise<Record<string, unknown> | null>>().mockResolvedValue(returnValue),
  }
}

describe('HookManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should load SessionStart hooks from hooks.json', async () => {
    const json = makeHooksJson({
      SessionStart: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'echo hello' }] },
      ],
    })
    mockedReadFile.mockResolvedValueOnce(json)

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/project/hooks.json', 'project')

    const hooks = manager.getHooks('SessionStart')
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.source).toBe('project')
    expect(hooks[0]!.action.command).toBe('echo hello')
    expect(hooks[0]!.cwd).toBe('/project')
  })

  it('should merge hooks from multiple sources (plugin + project + user)', async () => {
    const pluginJson = makeHooksJson({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'plugin-check' }] },
      ],
    })
    const projectJson = makeHooksJson({
      PreToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command', command: 'project-check' }] },
      ],
    })
    const userJson = makeHooksJson({
      PreToolUse: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'user-check' }] },
      ],
    })

    mockedReadFile.mockResolvedValueOnce(pluginJson)
    mockedReadFile.mockResolvedValueOnce(projectJson)
    mockedReadFile.mockResolvedValueOnce(userJson)

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/plugins/my-plugin/hooks.json', 'plugin', 'my-plugin')
    await manager.discoverFromFile('/project/hooks.json', 'project')
    await manager.discoverFromFile('/home/user/hooks.json', 'user')

    const hooks = manager.getHooks('PreToolUse')
    expect(hooks).toHaveLength(3)
    expect(hooks.map((h) => h.source)).toEqual(['plugin', 'project', 'user'])
  })

  it('should match hooks by trigger using regex matcher', async () => {
    const json = makeHooksJson({
      PreToolUse: [
        { matcher: '^startup$', hooks: [{ type: 'command', command: 'init-cmd' }] },
      ],
    })
    mockedReadFile.mockResolvedValueOnce(json)

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/project/hooks.json', 'project')

    const matched = manager.getMatchedHooks('PreToolUse', 'startup')
    expect(matched).toHaveLength(1)

    const notMatched = manager.getMatchedHooks('PreToolUse', 'other')
    expect(notMatched).toHaveLength(0)
  })

  it('should silently skip when file does not exist', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT: no such file'))

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/nonexistent/hooks.json', 'project')

    expect(manager.getHooks('SessionStart')).toHaveLength(0)
  })

  it('should silently skip when JSON is malformed', async () => {
    mockedReadFile.mockResolvedValueOnce('{ invalid json !!!')

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/project/hooks.json', 'project')

    expect(manager.getHooks('SessionStart')).toHaveLength(0)
  })

  it('should correctly filter by getMatchedHooks', async () => {
    const json = makeHooksJson({
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash-hook' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'write-hook' }] },
        { matcher: '.*', hooks: [{ type: 'command', command: 'catch-all' }] },
      ],
    })
    mockedReadFile.mockResolvedValueOnce(json)

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/project/hooks.json', 'project')

    const bashMatches = manager.getMatchedHooks('PostToolUse', 'Bash')
    expect(bashMatches).toHaveLength(2) // 'Bash' + '.*'
    expect(bashMatches.map((h) => h.action.command)).toEqual(['bash-hook', 'catch-all'])
  })

  it('should pass pluginName correctly to resolved entries', async () => {
    const json = makeHooksJson({
      SessionStart: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'plugin-init' }] },
      ],
    })
    mockedReadFile.mockResolvedValueOnce(json)

    const manager = new HookManager(createMockRunner())
    await manager.discoverFromFile('/plugins/awesome/hooks.json', 'plugin', 'awesome')

    const hooks = manager.getHooks('SessionStart')
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.pluginName).toBe('awesome')
    expect(hooks[0]!.source).toBe('plugin')
  })

  it('should run matched hooks and return results', async () => {
    const json = makeHooksJson({
      SessionStart: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'echo-hook' }] },
      ],
    })
    mockedReadFile.mockResolvedValueOnce(json)

    const mockRunner = createMockRunner({ additionalContext: 'extra info' })
    const manager = new HookManager(mockRunner)
    await manager.discoverFromFile('/project/hooks.json', 'project')

    const results = await manager.run('SessionStart', { trigger: 'startup' })
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ additionalContext: 'extra info' })
    expect(mockRunner.run).toHaveBeenCalledOnce()
  })

  it('should set CCODE_PLUGIN_ROOT env when running plugin hooks', async () => {
    const json = makeHooksJson({
      PreToolUse: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'check' }] },
      ],
    })
    mockedReadFile.mockResolvedValueOnce(json)

    const mockRunner = createMockRunner(null)
    const manager = new HookManager(mockRunner)
    await manager.discoverFromFile('/plugins/my-plugin/hooks.json', 'plugin', 'my-plugin')

    await manager.run('PreToolUse', { trigger: 'Bash' })

    const callArgs = (mockRunner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RunOptions
    expect(callArgs.env['CCODE_PLUGIN_ROOT']).toBe('/plugins/my-plugin')
  })
})

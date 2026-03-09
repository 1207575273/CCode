import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `.tmp-mcp-config-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

/** 在 testDir 下写入指定文件名的 JSON，返回绝对路径 */
function writeJsonFile(fileName: string, content: string): string {
  const filePath = join(testDir, fileName)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('loadMcpConfig', () => {
  it('加载包含 stdio server 的有效配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeJsonFile('mcp.json', JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['server.js'],
          env: { NODE_ENV: 'production' },
        },
      },
    }))

    const config = loadMcpConfig([configPath])

    expect(config.mcpServers).toHaveProperty('my-server')
    const server = config.mcpServers['my-server']!
    expect(server.command).toBe('node')
    expect(server.args).toEqual(['server.js'])
    expect(server.env).toEqual({ NODE_ENV: 'production' })
  })

  it('文件不存在时返回空配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const nonExistent = join(testDir, 'not-exist.json')

    const config = loadMcpConfig([nonExistent])

    expect(config.mcpServers).toEqual({})
  })

  it('JSON 格式无效时返回空配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeJsonFile('mcp.json', '{ invalid json !!!}')

    const config = loadMcpConfig([configPath])

    expect(config.mcpServers).toEqual({})
  })

  it('识别 stdio 传输类型（有 command + env）', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeJsonFile('mcp.json', JSON.stringify({
      mcpServers: {
        'stdio-server': {
          command: 'python',
          args: ['-m', 'mcp_server'],
          env: { PYTHONPATH: '/usr/lib' },
        },
      },
    }))

    const config = loadMcpConfig([configPath])
    const server = config.mcpServers['stdio-server']!

    expect(server.command).toBe('python')
    expect(server.args).toEqual(['-m', 'mcp_server'])
    expect(server.env).toEqual({ PYTHONPATH: '/usr/lib' })
    expect(server.type).toBeUndefined()
  })

  it('识别 SSE 传输类型（type: sse, url）', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeJsonFile('mcp.json', JSON.stringify({
      mcpServers: {
        'sse-server': {
          type: 'sse',
          url: 'http://localhost:3001/sse',
        },
      },
    }))

    const config = loadMcpConfig([configPath])
    const server = config.mcpServers['sse-server']!

    expect(server.type).toBe('sse')
    expect(server.url).toBe('http://localhost:3001/sse')
    expect(server.command).toBeUndefined()
  })

  it('识别 streamable-http 传输类型', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeJsonFile('mcp.json', JSON.stringify({
      mcpServers: {
        'http-server': {
          type: 'streamable-http',
          url: 'http://localhost:3002/mcp',
        },
      },
    }))

    const config = loadMcpConfig([configPath])
    const server = config.mcpServers['http-server']!

    expect(server.type).toBe('streamable-http')
    expect(server.url).toBe('http://localhost:3002/mcp')
  })

  it('多文件合并：高优先级文件的同名 server 覆盖低优先级', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')

    // 低优先级文件（模拟 ~/.mcp.json）
    const lowPriority = writeJsonFile('global-mcp.json', JSON.stringify({
      mcpServers: {
        'shared-server': {
          command: 'node',
          args: ['global-server.js'],
        },
        'global-only': {
          type: 'sse',
          url: 'http://localhost:4000/sse',
        },
      },
    }))

    // 高优先级文件（模拟 ~/.zcli/mcp.json）
    const highPriority = writeJsonFile('zcli-mcp.json', JSON.stringify({
      mcpServers: {
        'shared-server': {
          command: 'python',
          args: ['zcli-server.py'],
        },
        'zcli-only': {
          command: 'deno',
          args: ['run', 'server.ts'],
        },
      },
    }))

    // 高优先级在前（与 MCP_CONFIG_PATHS 顺序一致）
    const config = loadMcpConfig([highPriority, lowPriority])

    // 同名 server 使用高优先级版本
    expect(config.mcpServers['shared-server']!.command).toBe('python')
    expect(config.mcpServers['shared-server']!.args).toEqual(['zcli-server.py'])

    // 各自独有的 server 都保留
    expect(config.mcpServers['global-only']!.url).toBe('http://localhost:4000/sse')
    expect(config.mcpServers['zcli-only']!.command).toBe('deno')
  })

  it('多文件合并：部分文件不存在时正常加载存在的文件', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')

    const existing = writeJsonFile('existing.json', JSON.stringify({
      mcpServers: {
        'my-server': { command: 'node', args: ['s.js'] },
      },
    }))
    const missing = join(testDir, 'missing.json')

    const config = loadMcpConfig([existing, missing])

    expect(Object.keys(config.mcpServers)).toHaveLength(1)
    expect(config.mcpServers['my-server']!.command).toBe('node')
  })

  it('所有文件都不存在时返回空配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')

    const config = loadMcpConfig([
      join(testDir, 'a.json'),
      join(testDir, 'b.json'),
    ])

    expect(config.mcpServers).toEqual({})
  })
})

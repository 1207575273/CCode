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

function writeMcpJson(content: string): string {
  const filePath = join(testDir, 'mcp.json')
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('loadMcpConfig', () => {
  it('加载包含 stdio server 的有效配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeMcpJson(JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['server.js'],
          env: { NODE_ENV: 'production' },
        },
      },
    }))

    const config = loadMcpConfig(configPath)

    expect(config.mcpServers).toHaveProperty('my-server')
    const server = config.mcpServers['my-server']!
    expect(server.command).toBe('node')
    expect(server.args).toEqual(['server.js'])
    expect(server.env).toEqual({ NODE_ENV: 'production' })
  })

  it('文件不存在时返回空配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const nonExistent = join(testDir, 'not-exist.json')

    const config = loadMcpConfig(nonExistent)

    expect(config.mcpServers).toEqual({})
  })

  it('JSON 格式无效时返回空配置', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeMcpJson('{ invalid json !!!}')

    const config = loadMcpConfig(configPath)

    expect(config.mcpServers).toEqual({})
  })

  it('识别 stdio 传输类型（有 command + env）', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeMcpJson(JSON.stringify({
      mcpServers: {
        'stdio-server': {
          command: 'python',
          args: ['-m', 'mcp_server'],
          env: { PYTHONPATH: '/usr/lib' },
        },
      },
    }))

    const config = loadMcpConfig(configPath)
    const server = config.mcpServers['stdio-server']!

    expect(server.command).toBe('python')
    expect(server.args).toEqual(['-m', 'mcp_server'])
    expect(server.env).toEqual({ PYTHONPATH: '/usr/lib' })
    expect(server.type).toBeUndefined()
  })

  it('识别 SSE 传输类型（type: sse, url）', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeMcpJson(JSON.stringify({
      mcpServers: {
        'sse-server': {
          type: 'sse',
          url: 'http://localhost:3001/sse',
        },
      },
    }))

    const config = loadMcpConfig(configPath)
    const server = config.mcpServers['sse-server']!

    expect(server.type).toBe('sse')
    expect(server.url).toBe('http://localhost:3001/sse')
    expect(server.command).toBeUndefined()
  })

  it('识别 streamable-http 传输类型', async () => {
    const { loadMcpConfig } = await import('@config/mcp-config.js')
    const configPath = writeMcpJson(JSON.stringify({
      mcpServers: {
        'http-server': {
          type: 'streamable-http',
          url: 'http://localhost:3002/mcp',
        },
      },
    }))

    const config = loadMcpConfig(configPath)
    const server = config.mcpServers['http-server']!

    expect(server.type).toBe('streamable-http')
    expect(server.url).toBe('http://localhost:3002/mcp')
  })
})

// tests/unit/mcp-manager.test.ts

import { describe, it, expect } from 'vitest'
import { McpManager } from '@mcp/mcp-manager'
import type { McpConfigWithSources } from '@config/mcp-config'

describe('McpManager', () => {
  it('should_return_empty_tools_when_no_servers', async () => {
    const config: McpConfigWithSources = { mcpServers: {}, serverSources: {} }
    const manager = new McpManager(config)

    await manager.connectAll()

    expect(manager.getTools()).toEqual([])
    expect(manager.getStatus()).toEqual([])

    await manager.disconnectAll()
  })

  it('should_handle_connection_failure_gracefully', async () => {
    const config: McpConfigWithSources = {
      mcpServers: {
        broken: {
          command: 'ccode_nonexistent_binary_that_does_not_exist_12345',
          args: ['--foo'],
        },
      },
      serverSources: {
        broken: '/home/user/.ccode/mcp.json',
      },
    }
    const manager = new McpManager(config)

    // connectAll should NOT throw even when spawn fails
    await manager.connectAll()

    expect(manager.getTools()).toEqual([])

    // 失败的 server 也应出现在 getStatus 中
    const status = manager.getStatus()
    expect(status).toHaveLength(1)
    expect(status[0]!.name).toBe('broken')
    expect(status[0]!.status).toBe('failed')
    expect(status[0]!.source).toBe('/home/user/.ccode/mcp.json')
    expect(status[0]!.error).toBeDefined()

    await manager.disconnectAll()
  }, 15_000)
})

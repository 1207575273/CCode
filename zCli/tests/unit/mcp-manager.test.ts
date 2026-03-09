// tests/unit/mcp-manager.test.ts

import { describe, it, expect } from 'vitest'
import { McpManager } from '@mcp/mcp-manager'
import type { McpConfig } from '@config/mcp-config'

describe('McpManager', () => {
  it('should_return_empty_tools_when_no_servers', async () => {
    const config: McpConfig = { mcpServers: {} }
    const manager = new McpManager(config)

    await manager.connectAll()

    expect(manager.getTools()).toEqual([])

    await manager.disconnectAll()
  })

  it('should_handle_connection_failure_gracefully', async () => {
    const config: McpConfig = {
      mcpServers: {
        broken: {
          command: 'zcli_nonexistent_binary_that_does_not_exist_12345',
          args: ['--foo'],
        },
      },
    }
    const manager = new McpManager(config)

    // connectAll should NOT throw even when spawn fails
    await manager.connectAll()

    expect(manager.getTools()).toEqual([])

    await manager.disconnectAll()
  }, 15_000)
})

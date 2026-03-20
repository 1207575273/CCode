// tests/unit/mcp-tool.test.ts

import { describe, it, expect } from 'vitest'
import { McpTool } from '@mcp/mcp-tool'
import type { McpToolDefinition } from '@mcp/mcp-tool'
import type { Client } from '@modelcontextprotocol/sdk/client'

function mockClient(callResult: {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}) {
  return { callTool: async () => callResult } as unknown as Client
}

const baseDef: McpToolDefinition = {
  name: 'search',
  description: 'Search documents',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}

const baseCtx = { cwd: '/tmp' }

describe('McpTool', () => {
  it('should have namespaced name mcp__serverName__toolName', () => {
    const client = mockClient({ content: [{ type: 'text', text: 'ok' }] })
    const tool = new McpTool('myServer', baseDef, client)
    expect(tool.name).toBe('mcp__myServer__search')
  })

  it('should be dangerous', () => {
    const client = mockClient({ content: [{ type: 'text', text: 'ok' }] })
    const tool = new McpTool('srv', baseDef, client)
    expect(tool.dangerous).toBe(true)
  })

  it('should return success on normal call with text content', async () => {
    const client = mockClient({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
    })
    const tool = new McpTool('srv', baseDef, client)
    const result = await tool.execute({ query: 'test' }, baseCtx)
    expect(result).toEqual({ success: true, output: 'hello world' })
  })

  it('should return error when isError is true', async () => {
    const client = mockClient({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    })
    const tool = new McpTool('srv', baseDef, client)
    const result = await tool.execute({ query: 'bad' }, baseCtx)
    expect(result).toEqual({
      success: false,
      output: '',
      error: 'something went wrong',
    })
  })

  it('should handle client throw gracefully', async () => {
    const client = {
      callTool: async () => {
        throw new Error('connection lost')
      },
    } as unknown as Client
    const tool = new McpTool('srv', baseDef, client)
    const result = await tool.execute({ query: 'x' }, baseCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('connection lost')
  })

  it('should use inputSchema as parameters', () => {
    const client = mockClient({ content: [{ type: 'text', text: 'ok' }] })
    const tool = new McpTool('srv', baseDef, client)
    expect(tool.parameters).toEqual(baseDef.inputSchema)
  })
})

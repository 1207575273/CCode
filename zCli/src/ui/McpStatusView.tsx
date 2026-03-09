// src/ui/McpStatusView.tsx

/**
 * McpStatusView — MCP Server 状态全屏面板。
 *
 * 与 ModelPicker 相同的互斥模式：替换 InputBar 渲染，
 * Esc/q 退出。按来源配置文件分组展示连接状态。
 */

import React, { useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key } from 'ink'
import type { ServerInfo } from '@mcp/mcp-manager.js'

interface McpStatusViewProps {
  servers: ServerInfo[]
  /** 用户按 Esc/q 关闭面板时回调 */
  onClose: () => void
}

export function McpStatusView({ servers, onClose }: McpStatusViewProps) {
  // stableHandler：依赖 [onClose]，当 onClose 引用稳定时 handler 不会重建
  const stableHandler = useCallback((_input: string, key: Key) => {
    if (key.escape || _input === 'q') {
      onClose()
    }
  }, [onClose])

  useInput(stableHandler)

  if (servers.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text dimColor>MCP: 无配置的 Server</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc/q 退出</Text>
        </Box>
      </Box>
    )
  }

  // 按来源文件分组
  const grouped = new Map<string, ServerInfo[]>()
  for (const s of servers) {
    const list = grouped.get(s.source) ?? []
    list.push(s)
    grouped.set(s.source, list)
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Manage MCP servers</Text>
      <Text dimColor>  {servers.length} servers</Text>
      <Text> </Text>
      {[...grouped.entries()].map(([source, items]) => (
        <Box key={source} flexDirection="column">
          <Text dimColor>  MCPs ({source})</Text>
          {items.map(s => (
            <Box key={s.name} flexDirection="column">
              <Text>
                {'    '}{s.name} ·{' '}
                {s.status === 'connected' ? (
                  <Text color="green">✔ connected</Text>
                ) : (
                  <Text color="red">✘ failed</Text>
                )}
              </Text>
              {s.status === 'connected' && s.toolNames.map(toolName => (
                <Text key={toolName} dimColor>{'      '}- {toolName}</Text>
              ))}
            </Box>
          ))}
          <Text> </Text>
        </Box>
      ))}
      <Box>
        <Text dimColor>Esc/q 退出</Text>
      </Box>
    </Box>
  )
}

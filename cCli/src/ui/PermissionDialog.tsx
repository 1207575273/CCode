// src/ui/PermissionDialog.tsx

/**
 * PermissionDialog — 危险工具操作权限确认弹窗。
 *
 * 当 AgentLoop 遇到 dangerous=true 的工具（bash / write_file / edit_file）时，
 * 替换 InputBar 渲染，要求用户明确授权。
 *
 * 三个选项：
 *   1. Yes                      — 本次允许
 *   2. Yes, and don't ask again — 本次 + 将工具加入 session 级白名单
 *   3. No                       — 拒绝，工具调用返回 error
 */

import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { resolve } from 'node:path'
import { useTerminalSize } from './useTerminalSize.js'
import { DiffView } from './DiffView.js'
import { computeEditDiff, computeWriteDiff } from '@utils/compute-diff.js'

interface PermissionDialogProps {
  /** 工具名称，用于显示标题和生成参数预览 */
  toolName: string
  /** 工具调用参数，用于生成操作预览（如 bash 命令内容、文件路径） */
  args: Record<string, unknown>
  /**
   * 用户选择后回调。
   * @param allow  true = 允许执行，false = 拒绝
   * @param always true = 同时将该工具加入 session 白名单，后续不再询问
   */
  onResolve: (allow: boolean, always?: boolean) => void
}

const OPTIONS = [
  { label: 'Yes', value: 'yes' as const },
  { label: "Yes, and don't ask again", value: 'always' as const },
  { label: 'No', value: 'no' as const },
]

/** 工具名到用户友好标题的映射 */
const TOOL_TITLES: Record<string, string> = {
  bash: 'Bash command',
  write_file: 'Write file',
  edit_file: 'Edit file',
}

/**
 * 生成操作预览文本，帮助用户快速判断是否授权。
 * bash → 显示完整命令；文件操作 → 显示路径（write 额外显示字节数）。
 */
function formatPreview(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'bash') return String(args['command'] ?? '')
  if (toolName === 'write_file') return `${args['path']} (${String(args['content'] ?? '').length} chars)`
  if (toolName === 'edit_file') return String(args['path'] ?? '')
  // MCP 工具：显示 server + tool + 参数
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    const server = parts[1] ?? ''
    const tool = parts[2] ?? ''
    const argsStr = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : ''
    return `[${server}] ${tool}${argsStr ? '\n' + argsStr : ''}`
  }
  return JSON.stringify(args)
}

/**
 * 权限确认弹窗。
 * ↑↓ 导航选项，Enter 确认，Esc 等同于选择 No。
 */
export function PermissionDialog({ toolName, args, onResolve }: PermissionDialogProps) {
  const [selected, setSelected] = useState(0)
  const { columns } = useTerminalSize()

  useInput((_input, key) => {
    if (key.upArrow) setSelected(s => Math.max(0, s - 1))
    if (key.downArrow) setSelected(s => Math.min(OPTIONS.length - 1, s + 1))
    if (key.return) {
      const choice = OPTIONS[selected]?.value
      if (choice === 'yes') onResolve(true, false)
      else if (choice === 'always') onResolve(true, true)
      else onResolve(false, false)
    }
    // Esc 视为拒绝，与选择 No 等价
    if (key.escape) onResolve(false, false)
  })

  const diffData = useMemo(() => {
    const rawPath = String(args['path'] ?? '')
    const filePath = resolve(process.cwd(), rawPath)

    if (toolName === 'edit_file') {
      return computeEditDiff(filePath, String(args['old_str'] ?? ''), String(args['new_str'] ?? ''))
    }
    if (toolName === 'write_file') {
      return computeWriteDiff(filePath, String(args['content'] ?? ''))
    }
    return null
  }, [toolName, args])

  const title = toolName.startsWith('mcp__')
    ? `MCP: ${toolName.split('__')[2] ?? toolName}`
    : (diffData?.isNewFile ? 'Create file' : (TOOL_TITLES[toolName] ?? toolName))
  const preview = formatPreview(toolName, args)

  return (
    <Box flexDirection="column" width={columns}>
      <Box>
        <Text dimColor>{'─'.repeat(columns)}</Text>
      </Box>
      <Box paddingX={2} flexDirection="column">
        <Text bold color="yellow">{title}</Text>
        {diffData !== null ? (
          <Box marginY={1} paddingLeft={2}>
            <DiffView {...diffData} />
          </Box>
        ) : (
          <Box marginY={1} paddingLeft={2}>
            <Text dimColor>{preview}</Text>
          </Box>
        )}
        <Text>Do you want to proceed?</Text>
        {OPTIONS.map((opt, i) => (
          <Box key={opt.value} paddingLeft={1}>
            {i === selected
              ? <Text color="cyan">{'❯ '}{i + 1}. {opt.label}</Text>
              : <Text>{'  '}{i + 1}. {opt.label}</Text>
            }
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// src/ui/ResumePanel.tsx

/**
 * ResumePanel — 交互式全屏面板，用于恢复历史 session。
 *
 * 与 McpStatusView 相同的互斥模式：替换 InputBar 渲染。
 * 支持键盘导航（↑↓）、Enter 选择、Ctrl+A 切换项目范围、文本搜索、Esc 退出。
 */

import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key } from 'ink'
import type { SessionSummary, BranchInfo } from '@persistence/index.js'

export interface ResumePanelProps {
  currentProjectSessions: SessionSummary[]
  allSessions: SessionSummary[]
  /** 获取指定 session 的分支列表 */
  getBranches: (sessionId: string) => BranchInfo[]
  onSelect: (sessionId: string, leafEventUuid?: string) => void
  onClose: () => void
}

// ── Helper functions ──

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 将 ISO 时间字符串转为相对时间描述 */
function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  if (diff < 0) return '0s ago'
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  return `${Math.floor(diff / DAY)}d ago`
}

/** 将字节数格式化为可读大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 简单模糊匹配：query 中的每个字符按序出现在 text 中即匹配 */
function fuzzyMatch(text: string, query: string): boolean {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let ti = 0
  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const found = lowerText.indexOf(lowerQuery[qi]!, ti)
    if (found === -1) return false
    ti = found + 1
  }
  return true
}

const MAX_MESSAGE_LENGTH = 60

/** 分支子视图状态 */
interface BranchView {
  sessionId: string
  branches: BranchInfo[]
}

export function ResumePanel({
  currentProjectSessions,
  allSessions,
  getBranches,
  onSelect,
  onClose,
}: ResumePanelProps) {
  const [showAll, setShowAll] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [searchText, setSearchText] = useState('')
  /** 分支子视图：非 null 时显示分支列表而非 session 列表 */
  const [branchView, setBranchView] = useState<BranchView | null>(null)
  const [branchSelectedIndex, setBranchSelectedIndex] = useState(0)

  const baseSessions = showAll ? allSessions : currentProjectSessions
  const filtered = searchText
    ? baseSessions.filter(s => fuzzyMatch(s.firstMessage, searchText))
    : baseSessions

  const stableHandler = useCallback((input: string, key: Key) => {
    // ── 分支子视图键盘处理 ──
    if (branchView) {
      if (key.escape) {
        setBranchView(null)
        setBranchSelectedIndex(0)
        return
      }

      if (key.return) {
        const branch = branchView.branches[branchSelectedIndex]
        if (branch) {
          onSelect(branchView.sessionId, branch.leafEventUuid)
        }
        return
      }

      if (key.upArrow) {
        setBranchSelectedIndex(i => Math.max(0, i - 1))
        return
      }

      if (key.downArrow) {
        setBranchSelectedIndex(i => Math.min(branchView.branches.length - 1, i + 1))
        return
      }
      return
    }

    // ── Session 列表键盘处理 ──
    if (key.escape) {
      onClose()
      return
    }

    if (key.return) {
      if (filtered.length > 0) {
        const session = filtered[selectedIndex]
        if (session) {
          // 检查是否有多个分支
          const branches = getBranches(session.sessionId)
          if (branches.length > 1) {
            // 有多个分支，进入分支子视图
            setBranchView({ sessionId: session.sessionId, branches })
            setBranchSelectedIndex(0)
          } else {
            // 单分支或无分支，直接选择
            onSelect(session.sessionId)
          }
        }
      }
      return
    }

    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(i => Math.min(filtered.length - 1, i + 1))
      return
    }

    // Ctrl+A toggle
    if (key.ctrl && input === 'a') {
      setShowAll(prev => !prev)
      setSelectedIndex(0)
      return
    }

    // Backspace
    if (key.backspace || key.delete) {
      setSearchText(prev => prev.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    // Printable character → append to search
    if (input && !key.ctrl && !key.meta) {
      setSearchText(prev => prev + input)
      setSelectedIndex(0)
    }
  }, [onClose, onSelect, filtered, selectedIndex, branchView, branchSelectedIndex, getBranches])

  useInput(stableHandler)

  // ── 分支子视图渲染 ──
  if (branchView) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Select Branch</Text>
        <Text dimColor>  {branchView.branches.length} branches found</Text>
        <Text> </Text>

        {branchView.branches.map((branch, index) => {
          const isSelected = index === branchSelectedIndex
          const prefix = isSelected ? '> ' : '  '
          const message = branch.lastMessage.length > MAX_MESSAGE_LENGTH
            ? branch.lastMessage.slice(0, MAX_MESSAGE_LENGTH) + '...'
            : branch.lastMessage
          const label = message || '(empty branch)'

          return (
            <Box key={branch.leafEventUuid}>
              {isSelected ? (
                <Text color="cyan" bold>{prefix}{label}</Text>
              ) : (
                <Text>{prefix}{label}</Text>
              )}
              <Text dimColor>
                {' · '}{branch.messageCount} msgs
                {' · '}{timeAgo(branch.updatedAt)}
                {branch.forkPoint ? ' · forked' : ' · main'}
              </Text>
            </Box>
          )
        })}

        <Text> </Text>
        <Box>
          <Text dimColor>Up/Down navigate - Enter select branch - Esc back to sessions</Text>
        </Box>
      </Box>
    )
  }

  // ── Session 列表渲染 ──
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Resume Session</Text>
      <Text dimColor>
        {'  '}{showAll ? 'All projects' : 'Current project'} · {filtered.length} sessions
        {' · Ctrl+A toggle scope'}
      </Text>

      {searchText.length > 0 && (
        <Box marginTop={1}>
          <Text>Search: <Text color="cyan">{searchText}</Text></Text>
        </Box>
      )}

      <Text> </Text>

      {filtered.length === 0 ? (
        <Box>
          <Text dimColor>  {searchText ? 'No sessions match your search' : 'No sessions found'}</Text>
        </Box>
      ) : (
        filtered.map((session, index) => {
          const isSelected = index === selectedIndex
          const prefix = isSelected ? '> ' : '  '
          const message = session.firstMessage.length > MAX_MESSAGE_LENGTH
            ? session.firstMessage.slice(0, MAX_MESSAGE_LENGTH) + '...'
            : session.firstMessage
          return (
            <Box key={session.sessionId}>
              {isSelected ? (
                <Text color="cyan" bold>{prefix}{message}</Text>
              ) : (
                <Text>{prefix}{message}</Text>
              )}
              <Text dimColor>
                {' · '}{timeAgo(session.updatedAt)}
                {session.gitBranch ? ` · ${session.gitBranch}` : ''}
                {' · '}{formatSize(session.fileSize)}
              </Text>
            </Box>
          )
        })
      )}

      <Text> </Text>
      <Box>
        <Text dimColor>Up/Down navigate - Enter select - Esc close - type to search</Text>
      </Box>
    </Box>
  )
}

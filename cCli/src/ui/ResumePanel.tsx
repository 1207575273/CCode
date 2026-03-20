// src/ui/ResumePanel.tsx

/**
 * ResumePanel — 交互式全屏面板，用于恢复历史 session。
 *
 * 布局：标题 → 搜索框（TextInput）→ 会话列表
 * 搜索框是可选中项（index -1），↑↓ 可在搜索框与列表之间导航。
 * 列表第一项固定为「Current Session」，选中后关闭面板回到当前对话。
 */

import React, { useState, useCallback, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key } from 'ink'
import TextInput from 'ink-text-input'
import type { SessionSummary, BranchInfo } from '@persistence/index.js'

export interface ResumePanelProps {
  currentProjectSessions: SessionSummary[]
  allSessions: SessionSummary[]
  /** 获取指定 session 的分支列表 */
  getBranches: (sessionId: string) => BranchInfo[]
  onSelect: (sessionId: string, leafEventUuid?: string) => void
  onClose: () => void
  /** 是否有活跃的当前会话（有则显示 Current Session 项） */
  hasCurrentSession?: boolean
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

/**
 * selectedIndex 含义：
 *   -1  = 搜索框聚焦（TextInput 激活，可输入文字）
 *    0  = "Current Session"（如有）或第一条 session
 *    1+ = 后续 session 条目
 *
 * hasCurrentSession 为 true 时，index 0 = Current Session，index 1+ = sessions
 * hasCurrentSession 为 false 时，index 0+ = sessions（无 Current Session 项）
 */
export function ResumePanel({
  currentProjectSessions,
  allSessions,
  getBranches,
  onSelect,
  onClose,
  hasCurrentSession = true,
}: ResumePanelProps) {
  const [showAll, setShowAll] = useState(false)
  // -1 = 搜索框聚焦；0+ = 列表项
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [searchText, setSearchText] = useState('')
  /** 分支子视图 */
  const [branchView, setBranchView] = useState<BranchView | null>(null)
  const [branchSelectedIndex, setBranchSelectedIndex] = useState(0)

  const baseSessions = showAll ? allSessions : currentProjectSessions
  const filtered = searchText
    ? baseSessions.filter(s => fuzzyMatch(s.firstMessage, searchText))
    : baseSessions

  // 列表总项数：Current Session（可选）+ filtered sessions
  const currentSessionOffset = hasCurrentSession ? 1 : 0
  const totalItems = currentSessionOffset + filtered.length
  const maxIndex = totalItems - 1

  /** 选中列表项后的处理 */
  const handleItemSelect = useCallback((index: number) => {
    // Current Session 项
    if (hasCurrentSession && index === 0) {
      onClose()
      return
    }

    const sessionIdx = index - currentSessionOffset
    const session = filtered[sessionIdx]
    if (!session) return

    const branches = getBranches(session.sessionId)
    if (branches.length > 1) {
      setBranchView({ sessionId: session.sessionId, branches })
      setBranchSelectedIndex(0)
    } else {
      onSelect(session.sessionId)
    }
  }, [hasCurrentSession, currentSessionOffset, filtered, getBranches, onSelect, onClose])

  // ── 键盘：分支子视图 ──
  const branchHandler = useCallback((_input: string, key: Key) => {
    if (key.escape) {
      setBranchView(null)
      setBranchSelectedIndex(0)
      return
    }
    if (key.return) {
      const branch = branchView?.branches[branchSelectedIndex]
      if (branch && branchView) {
        onSelect(branchView.sessionId, branch.leafEventUuid)
      }
      return
    }
    if (key.upArrow) {
      setBranchSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow && branchView) {
      setBranchSelectedIndex(i => Math.min(branchView.branches.length - 1, i + 1))
    }
  }, [branchView, branchSelectedIndex, onSelect])

  // ── 键盘：主列表导航（仅处理箭头、Esc、Ctrl+A、Enter） ──
  // 当 selectedIndex === -1（搜索框聚焦）时，字符输入由 TextInput 处理
  const navHandler = useCallback((input: string, key: Key) => {
    if (key.escape) {
      if (searchText) {
        // 有搜索内容时先清空搜索
        setSearchText('')
        setSelectedIndex(-1)
      } else {
        onClose()
      }
      return
    }

    // Ctrl+A toggle scope
    if (key.ctrl && input === 'a') {
      setShowAll(prev => !prev)
      setSelectedIndex(-1)
      return
    }

    if (key.upArrow) {
      setSelectedIndex(i => Math.max(-1, i - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(i => Math.min(maxIndex, i + 1))
      return
    }

    if (key.return && selectedIndex >= 0) {
      handleItemSelect(selectedIndex)
    }
  }, [searchText, onClose, maxIndex, selectedIndex, handleItemSelect])

  useInput(branchView ? branchHandler : navHandler)

  // 搜索框是否聚焦（TextInput 激活）
  const searchFocused = selectedIndex === -1 && !branchView

  // ── 分支子视图渲染 ──
  if (branchView) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Select Branch</Text>
        <Text dimColor>  {branchView.branches.length} branches found</Text>
        <Text> </Text>

        {branchView.branches.map((branch, index) => {
          const isSelected = index === branchSelectedIndex
          const prefix = isSelected ? '❯ ' : '  '
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
          <Text dimColor>Up/Down navigate · Enter select branch · Esc back to sessions</Text>
        </Box>
      </Box>
    )
  }

  // ── Session 列表渲染 ──
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="blue">Resume Session</Text>

      {/* 搜索框：用 TextInput 实现真实输入体验 */}
      <Box
        borderStyle="round"
        borderColor={searchFocused ? 'cyan' : 'gray'}
        paddingX={1}
        marginTop={1}
      >
        <Text>{'🔍 '}</Text>
        <TextInput
          value={searchText}
          onChange={(val) => {
            setSearchText(val)
            setSelectedIndex(-1) // 输入时自动聚焦回搜索框
          }}
          placeholder="Search..."
          focus={searchFocused}
        />
      </Box>

      <Text dimColor>
        {'  '}{showAll ? 'All projects' : 'Current project'} · {filtered.length} sessions
      </Text>

      <Text> </Text>

      {/* Current Session 项 */}
      {hasCurrentSession && (
        <Box flexDirection="column">
          <Box>
            {selectedIndex === 0 ? (
              <Text color="cyan" bold>{'❯ ↩ Current Session'}</Text>
            ) : (
              <Text>{'  ↩ Current Session'}</Text>
            )}
          </Box>
          <Box>
            <Text dimColor>{'  Back to current conversation'}</Text>
          </Box>
        </Box>
      )}

      {/* Session 列表 */}
      {filtered.length === 0 ? (
        <Box>
          <Text dimColor>  {searchText ? 'No sessions match your search' : 'No sessions found'}</Text>
        </Box>
      ) : (
        filtered.map((session, index) => {
          const itemIndex = index + currentSessionOffset
          const isSelected = itemIndex === selectedIndex
          const prefix = isSelected ? '❯ ' : '  '
          const message = session.firstMessage || '(session)'
          const displayMsg = message.length > MAX_MESSAGE_LENGTH
            ? message.slice(0, MAX_MESSAGE_LENGTH) + '...'
            : message
          return (
            <Box key={session.sessionId} flexDirection="column">
              <Box>
                {isSelected ? (
                  <Text color="cyan" bold>{prefix}{displayMsg}</Text>
                ) : (
                  <Text>{prefix}{displayMsg}</Text>
                )}
              </Box>
              <Box>
                <Text dimColor>
                  {'  '}{timeAgo(session.updatedAt)}
                  {session.gitBranch ? ` · ${session.gitBranch}` : ''}
                  {' · '}{formatSize(session.fileSize)}
                </Text>
              </Box>
            </Box>
          )
        })
      )}

      <Text> </Text>
      <Box>
        <Text dimColor>Type to Search · Enter to select · Ctrl+A {showAll ? 'current project' : 'all projects'} · Esc to clear</Text>
      </Box>
    </Box>
  )
}

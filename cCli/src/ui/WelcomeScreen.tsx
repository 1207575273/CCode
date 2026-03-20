// src/ui/WelcomeScreen.tsx

/**
 * WelcomeScreen — 初始欢迎界面。
 *
 * 在没有任何消息（started=false）时替代 ChatView 展示。
 * 双栏布局：左栏显示 ASCII 机器人 + 当前模型/路径信息；
 * 右栏显示使用提示和最近会话（当前为占位）。
 */

import React from 'react'
import { Box, Text } from 'ink'

const APP_VERSION = 'v0.0.4'

// 时间常量（与 ResumePanel 相同，按任务要求独立维护）
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

/** 截断字符串到指定长度，超出部分用省略号替代 */
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}
const LEFT_PANEL_WIDTH = 28

// 像素风格机器人（块元素字符 U+2580 系列）
const ROBOT_ART = [
  '  ▄██████▄  ',
  '  █ ■  ■ █  ',
  '  █  ▄▄  █  ',
  '  ▀██████▀  ',
  '   ██  ██   ',
]

// 竖分隔线：固定行数覆盖左栏最大高度（标题1 + 机器人5 + 信息3 + 间距2 = 11）
const DIVIDER_LINES = Array.from({ length: 11 }, (_, i) => i)

interface WelcomeScreenProps {
  /** 当前激活的模型名，从 useChat.currentModel 传入 */
  model: string
  /** 当前激活的 provider 名，从 useChat.currentProvider 传入 */
  provider: string
  /** 工作目录，用于在左栏底部显示上下文路径 */
  cwd: string
  /** 最近会话列表，用于在右栏展示 */
  recentSessions?: Array<{ firstMessage: string; updatedAt: string }>
}

/** 启动欢迎界面，会话开始后（有消息时）被 ChatView 替换。 */
export function WelcomeScreen({ model, provider, cwd, recentSessions }: WelcomeScreenProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="red"
      flexDirection="column"
      marginX={1}
    >
      {/* 标题行 */}
      <Box paddingX={1} marginBottom={1}>
        <Text color="red" bold>── CCode {APP_VERSION} ──</Text>
      </Box>

      {/* 双栏主体 */}
      <Box flexDirection="row">
        {/* 左栏：用户信息 + ASCII 机器人 */}
        <Box
          flexDirection="column"
          width={LEFT_PANEL_WIDTH}
          paddingLeft={2}
          paddingRight={2}
        >
          <Text bold color="white">Welcome back!</Text>
          <Box flexDirection="column" marginY={1}>
            {ROBOT_ART.map((line) => (
              <Text key={line} color="red">{line}</Text>
            ))}
          </Box>
          <Text color="white">{model}</Text>
          <Text dimColor>{provider}</Text>
          <Text dimColor wrap="truncate">{cwd}</Text>
        </Box>

        {/* 竖分隔线 */}
        <Box flexDirection="column" marginRight={2}>
          {DIVIDER_LINES.map((i) => (
            <Text key={i} dimColor>│</Text>
          ))}
        </Box>

        {/* 右栏：提示 + 最近记录 */}
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          <Text color="yellow" bold>Tips for getting started</Text>
          <Text>输入 <Text color="cyan">/help</Text> 查看可用命令</Text>
          <Text>输入 <Text color="cyan">/model</Text> 切换模型</Text>

          <Box marginTop={1} flexDirection="column">
            <Text color="yellow" bold>Recent sessions</Text>
            {recentSessions && recentSessions.length > 0 ? (
              <>
                {recentSessions.slice(0, 3).map((s, i) => (
                  <Text key={s.updatedAt + String(i)} dimColor>
                    {truncate(s.firstMessage, 50)}  <Text color="gray">{timeAgo(s.updatedAt)}</Text>
                  </Text>
                ))}
                <Text dimColor>输入 <Text color="cyan">/resume</Text> 查看更多</Text>
              </>
            ) : (
              <Text dimColor>No recent activity</Text>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

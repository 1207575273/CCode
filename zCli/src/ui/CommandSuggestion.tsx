/**
 * CommandSuggestion — 指令建议浮层（纯显示组件）
 *
 * 接收已过滤的建议列表与当前高亮索引，渲染为轻量浮层。
 * 无自身状态，无 useInput — 所有导航逻辑由父组件（App.tsx）的 useInput 管理。
 * 渲染位置：InputBar 正上方（由 App.tsx 布局决定）。
 */
import React from 'react'
import { Box, Text } from 'ink'

/** 单条建议项的数据结构 */
export interface SuggestionItem {
  name: string
  aliases?: readonly string[]
  description: string
}

export interface CommandSuggestionProps {
  /** 已过滤的建议列表（由父组件计算后传入） */
  items: SuggestionItem[]
  /** 当前高亮行索引（由父组件管理） */
  selectedIndex: number
}

/** command 列宽，右侧补空格对齐 description */
const CMD_COL_WIDTH = 10

/**
 * 渲染指令建议浮层。
 *
 * 每行格式：`❯ /name(alias)  description`（高亮行）
 *           `  /name(alias)  description`（其余行）
 * command name 绿色，description dimColor，❯ 绿色。
 */
export function CommandSuggestion({ items, selectedIndex }: CommandSuggestionProps) {
  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex
        // aliases 展示为 (m) 后缀，如 /model(m)
        const aliasStr = item.aliases && item.aliases.length > 0
          ? `(${item.aliases[0]})`
          : ''
        const nameWithAlias = `/${item.name}${aliasStr}`
        // 右侧补空格使 description 列对齐
        const padded = nameWithAlias.padEnd(CMD_COL_WIDTH)

        return (
          <Box key={item.name}>
            {/* 高亮指示符：❯ 或两空格占位 */}
            {isSelected
              ? <Text color="green">{'❯ '}</Text>
              : <Text>{'  '}</Text>
            }
            <Text color="green">{padded}</Text>
            <Text dimColor>{'  '}{item.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

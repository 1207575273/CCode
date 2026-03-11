/**
 * CommandSuggestion — 指令建议浮层（纯显示组件）
 *
 * 接收已过滤的建议列表与当前高亮索引，渲染为轻量浮层。
 * 无自身状态，无 useInput — 所有导航逻辑由父组件（App.tsx）的 useInput 管理。
 * 渲染位置：InputBar 正下方（由 App.tsx 布局决定）。
 */
import React from 'react'
import { Box, Text } from 'ink'

/** 单条建议项的数据结构 */
export interface SuggestionItem {
  name: string
  aliases?: readonly string[]
  description: string
  /** 来源标签（如 "builtin"、"project"），skills 显示来源 */
  source?: string
}

export interface CommandSuggestionProps {
  /** 已过滤的建议列表（由父组件计算后传入） */
  items: SuggestionItem[]
  /** 当前高亮行索引（由父组件管理） */
  selectedIndex: number
}

/**
 * 渲染指令建议浮层。
 *
 * 指令格式：`/name(alias)       description`
 * Skill 格式：`/skill-name        (source) description`
 */
export function CommandSuggestion({ items, selectedIndex }: CommandSuggestionProps) {
  // 动态计算名称列宽度，适配长 skill 名称
  const nameColWidth = Math.max(
    10,
    ...items.map(item => {
      const aliasStr = item.aliases?.length ? `(${item.aliases[0]})` : ''
      return (`/${item.name}${aliasStr}`).length + 2
    }),
  )

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex
        const aliasStr = item.aliases?.length ? `(${item.aliases[0]})` : ''
        const nameWithAlias = `/${item.name}${aliasStr}`
        const padded = nameWithAlias.padEnd(nameColWidth)
        // 来源标签：skills 显示 (builtin)/(project) 等
        const sourceTag = item.source ? `(${item.source}) ` : ''

        return (
          <Box key={item.name}>
            {isSelected
              ? <Text color="cyan">{'❯ '}</Text>
              : <Text>{'  '}</Text>
            }
            <Text color={isSelected ? 'cyan' : 'green'}>{padded}</Text>
            {sourceTag && <Text color={isSelected ? 'cyan' : 'yellow'}>{sourceTag}</Text>}
            <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected}>{item.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * CommandSuggestion — 指令建议浮层（纯显示组件）
 *
 * 接收已过滤的建议列表与当前高亮索引，渲染为轻量浮层。
 * 无自身状态，无 useInput — 所有导航逻辑由父组件（App.tsx）的 useInput 管理。
 * 渲染位置：InputBar 正下方（由 App.tsx 布局决定）。
 *
 * 可视窗口：最多显示 MAX_VISIBLE 条，超出时跟随高亮索引自动滚动。
 * 循环导航由父组件 App.tsx 的 useInput 处理（到底回顶部、到顶回底部）。
 */
import React from 'react'
import { Box, Text } from 'ink'

/** 可视窗口最大行数 */
const MAX_VISIBLE = 9

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
 *
 * 超过 MAX_VISIBLE 条时只显示可视窗口，尾部附加滚动提示。
 */
export function CommandSuggestion({ items, selectedIndex }: CommandSuggestionProps) {
  const total = items.length
  const needScroll = total > MAX_VISIBLE

  // 计算可视窗口的起止索引，保证选中项始终在窗口内
  let startIdx = 0
  if (needScroll) {
    // 窗口跟随选中项：选中项尽量在窗口中间偏上位置
    const half = Math.floor(MAX_VISIBLE / 2)
    startIdx = selectedIndex - half
    if (startIdx < 0) startIdx = 0
    if (startIdx + MAX_VISIBLE > total) startIdx = total - MAX_VISIBLE
  }
  const visibleItems = needScroll ? items.slice(startIdx, startIdx + MAX_VISIBLE) : items

  // 动态计算名称列宽度（基于可视窗口内的项目，避免跳动可用全量计算）
  const nameColWidth = Math.max(
    10,
    ...items.map(item => {
      const aliasStr = item.aliases?.length ? `(${item.aliases[0]})` : ''
      return (`/${item.name}${aliasStr}`).length + 2
    }),
  )

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, visibleIdx) => {
        const realIndex = startIdx + visibleIdx
        const isSelected = realIndex === selectedIndex
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
      {needScroll && (
        <Text dimColor>  ({selectedIndex + 1}/{total}) ↑↓ 滚动浏览</Text>
      )}
    </Box>
  )
}

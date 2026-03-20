/**
 * AtSuggestion — @ 文件建议浮层（纯显示组件）
 *
 * 两种模式：
 * - 目录浏览模式：输入 @ 或 @dir/ 时，展示当前目录下的文件和文件夹
 * - 模糊搜索模式：输入 @query 时，模糊匹配全部文件路径
 *
 * 显示风格：
 *   + .claude\
 *   + src\
 *   + README.md
 *
 * 文件夹以 "\" 结尾表示可继续展开，选中文件夹会导航进入（由父组件处理）。
 */
import React from 'react'
import { Box, Text } from 'ink'

/** 可视窗口最大行数 */
const MAX_VISIBLE = 9

/** 单条建议项 */
export interface AtSuggestionItem {
  /** 完整相对路径（正斜杠分隔） */
  path: string
  /** 显示文本 */
  display: string
  /** 是否为目录 */
  isDir: boolean
}

export interface AtSuggestionProps {
  items: AtSuggestionItem[]
  selectedIndex: number
}

/**
 * 从模糊搜索结果构造 AtSuggestionItem（搜索模式）。
 * 显示完整路径，用反斜杠替换正斜杠（Windows 风格）。
 */
export function createSearchItem(path: string): AtSuggestionItem {
  return { path, display: path.replaceAll('/', '\\'), isDir: false }
}

/**
 * 从目录条目构造 AtSuggestionItem（浏览模式）。
 * 目录显示名末尾 "/" → "\"，文件原样显示。
 */
export function createBrowseItem(name: string, fullPath: string, isDir: boolean): AtSuggestionItem {
  const display = isDir ? name.replace(/\/$/, '\\') : name
  return { path: fullPath, display, isDir }
}

export function AtSuggestion({ items, selectedIndex }: AtSuggestionProps) {
  const total = items.length
  const needScroll = total > MAX_VISIBLE

  let startIdx = 0
  if (needScroll) {
    const half = Math.floor(MAX_VISIBLE / 2)
    startIdx = selectedIndex - half
    if (startIdx < 0) startIdx = 0
    if (startIdx + MAX_VISIBLE > total) startIdx = total - MAX_VISIBLE
  }
  const visibleItems = needScroll ? items.slice(startIdx, startIdx + MAX_VISIBLE) : items

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, visibleIdx) => {
        const realIndex = startIdx + visibleIdx
        const isSelected = realIndex === selectedIndex

        return (
          <Box key={item.path + (item.isDir ? '/' : '')}>
            <Text {...(isSelected ? { color: 'cyan', bold: true } : {})}>
              {isSelected ? '+ ' : '  '}
            </Text>
            <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {item.display}
            </Text>
          </Box>
        )
      })}
      {needScroll && (
        <Text dimColor>  ({selectedIndex + 1}/{total}) ↑↓ 滚动</Text>
      )}
    </Box>
  )
}

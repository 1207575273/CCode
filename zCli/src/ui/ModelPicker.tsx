// src/ui/ModelPicker.tsx

/**
 * ModelPicker — 交互式模型选择弹窗。
 *
 * 替换 InputBar 渲染（与 PermissionDialog 相同的互斥模式），
 * 通过 ↑↓ 方向键导航，Enter 确认，Esc 取消。
 * items 由外部（App.tsx）传入，组件不直接读取 config，保持关注点分离。
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key } from 'ink'

/** model 列列宽（字符数），用于 padEnd 对齐显示 */
const MODEL_COL_WIDTH = 20
/** provider 列列宽（字符数） */
const PROVIDER_COL_WIDTH = 12

/** 单个可选模型项 */
export interface ModelItem {
  provider: string
  model: string
}

export interface ModelPickerProps {
  /** 当前激活的 provider，用于初始光标定位和 ✓ 标记 */
  currentProvider: string
  /** 当前激活的模型名，用于初始光标定位和 ✓ 标记 */
  currentModel: string
  /** 全部可选模型列表，由 App.tsx 从 config 枚举生成 */
  items: ModelItem[]
  /** 用户确认选择时回调 */
  onSelect: (provider: string, model: string) => void
  /** 用户按 Esc 取消时回调 */
  onCancel: () => void
}

/**
 * 模型选择弹窗组件。
 * 挂载时自动将光标定位到当前激活模型；若未找到匹配项则停在第一项。
 */
export function ModelPicker({
  currentProvider,
  currentModel,
  items,
  onSelect,
  onCancel,
}: ModelPickerProps) {
  // lazy initializer：只在首次渲染时查找当前模型的索引，避免每次渲染重复遍历
  const [selected, setSelected] = useState(() => {
    const idx = items.findIndex(
      item => item.provider === currentProvider && item.model === currentModel
    )
    return idx >= 0 ? idx : 0
  })

  // dual-track ref 模式：Ink 的 useInput 每当 inputHandler 引用变化时会重新注册监听器。
  // 若 App.tsx 因流式输出等原因频繁重渲染，onCancel/onSelect prop 的引用每次都会变化，
  // 导致监听器在「卸载旧→注册新」的间隙中丢失 Esc 等按键事件。
  // 解决方案：用 ref 同步最新值，useInput 回调本身保持稳定引用（useCallback 空依赖）。
  const onCancelRef = useRef(onCancel)
  const onSelectRef = useRef(onSelect)
  const itemsRef    = useRef(items)
  const selectedRef = useRef(selected)

  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])
  useEffect(() => { onSelectRef.current = onSelect  }, [onSelect])
  useEffect(() => { itemsRef.current    = items      }, [items])
  useEffect(() => { selectedRef.current = selected   }, [selected])

  // stableHandler：依赖数组为空，Ink 永不重新注册，彻底消除按键丢失的竞态窗口
  const stableHandler = useCallback((input: string, key: Key) => {
    // 循环导航：到达边界时回绕到另一端
    if (key.upArrow) {
      setSelected(s => {
        const next = (s - 1 + itemsRef.current.length) % itemsRef.current.length
        selectedRef.current = next
        return next
      })
    }
    if (key.downArrow) {
      setSelected(s => {
        const next = (s + 1) % itemsRef.current.length
        selectedRef.current = next
        return next
      })
    }
    if (key.return) {
      const item = itemsRef.current[selectedRef.current]
      if (item != null) {
        onSelectRef.current(item.provider, item.model)
      }
    }
    // Esc：独立终端可用；IDE（IntelliJ/VSCode）可能在系统层拦截 Esc，
    // 导致 stdin 根本收不到 \x1b。因此同时支持 'q' 作为备用退出键。
    if (key.escape || input === 'q') {
      onCancelRef.current()
    }
  }, [])  // 空依赖：回调永远稳定

  useInput(stableHandler)

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="yellow">暂无可用模型</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        当前模型: <Text bold color="cyan">{currentModel}</Text>
        <Text dimColor> ({currentProvider})</Text>
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>可用模型:</Text>
        {items.map((item, i) => {
          const isCurrent = item.provider === currentProvider && item.model === currentModel
          const isSelected = i === selected
          const cursor = isSelected ? '❯' : ' '
          // 价格数据待 F10 实现后填入，当前显示占位符
          const priceStr = '--  / --'

          return (
            <Box key={`${item.provider}:${item.model}`} paddingLeft={1}>
              {isSelected ? (
                <Text color="cyan">
                  {cursor} {i + 1}. {item.model.padEnd(MODEL_COL_WIDTH)} {item.provider.padEnd(PROVIDER_COL_WIDTH)} {priceStr}
                  {isCurrent ? <Text color="green"> ✓</Text> : ''}
                </Text>
              ) : (
                <Text dimColor={!isCurrent}>
                  {'  '}{i + 1}. {item.model.padEnd(MODEL_COL_WIDTH)} {item.provider.padEnd(PROVIDER_COL_WIDTH)} {priceStr}
                  {isCurrent ? <Text color="green"> ✓</Text> : ''}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择   Enter 确认   Esc/q 取消</Text>
      </Box>
    </Box>
  )
}

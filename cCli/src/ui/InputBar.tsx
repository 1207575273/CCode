// src/ui/InputBar.tsx

/**
 * InputBar — 底部多行文本输入组件。
 *
 * 使用 ControlledMultilineInput（纯展示）+ 自管键盘逻辑。
 * Enter 提交，Alt+Enter 换行。
 * Home/Ctrl+A → 当前行首，End/Ctrl+E → 当前行尾。
 * ↑↓ 在第一行/最后一行时翻阅历史输入。
 */

import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput, useStdin } from 'ink'
import { ControlledMultilineInput } from 'ink-multiline-input'
import { useTerminalSize } from './useTerminalSize.js'

interface InputBarProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onInterruptSubmit?: ((value: string) => void) | undefined
  placeholder?: string
  streaming?: boolean
  /** 历史用户输入消息列表（从旧到新），用于 ↑↓ 翻阅 */
  history?: string[]
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// ─── 已经被你验证成功的核心计算逻辑 ───
function findLastNewline(str: string, fromIdx: number): number {
  return Math.max(str.lastIndexOf('\n', fromIdx), str.lastIndexOf('\r', fromIdx))
}

function findNextNewline(str: string, fromIdx: number): number {
  const n = str.indexOf('\n', fromIdx)
  const r = str.indexOf('\r', fromIdx)
  if (n === -1) return r
  if (r === -1) return n
  return Math.min(n, r)
}

export function InputBar({
                           value,
                           onChange,
                           onSubmit,
                           onInterruptSubmit,
                           placeholder = 'Try "how does <filepath> work?"',
                           streaming = false,
                           history = [],
                         }: InputBarProps) {
  const { columns } = useTerminalSize()

  // 【关键点1】拉取原生的 stdin 流
  const { stdin } = useStdin()

  const [cursorIndex, setCursorIndex] = useState(value.length)

  // ─── 历史翻阅状态 ───
  // historyIndex: -1 = 当前 draft，0 = 最近一条历史，1 = 倒数第二条...
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftRef = useRef(value)  // 保存用户未发送的输入

  const valueRef = useRef(value)
  const cursorRef = useRef(cursorIndex)
  // 标记：stdin raw listener 已处理当前按键（防止 useInput 重复处理 Delete 键）
  const handledByRawRef = useRef(false)
  valueRef.current = value
  cursorRef.current = cursorIndex

  useEffect(() => {
    if (cursorIndex > value.length) {
      setCursorIndex(value.length)
    }
  }, [value, cursorIndex])

  // ─── 【关键点2】stdin raw 拦截：处理 Ink useInput 无法正确识别的特殊按键 ───
  // 覆盖场景：
  //   1. Home/End：Windows CMD/PowerShell 发送非标准扫描码 (e047/e04f)
  //   2. Delete 键：Linux 上 \x1b[3~ 被 Ink 解析为 key.delete，与 Backspace(\x7f) 混淆
  //      因此 useInput 中统一将 key.delete 当退格处理，真正的 Delete 在这里单独处理
  useEffect(() => {
    if (!stdin) return

    const onData = (data: Buffer) => {
      const hex = data.toString('hex')
      const str = data.toString('utf8')

      const val = valueRef.current
      const cur = cursorRef.current

      // Home 键：Linux/Mac 标准序列 + Windows Terminal + Windows 原生 CMD/PowerShell 扫描码
      const isHome =
          str === '\x1b[H' || str === '\x1b[1~' || str === '\x1b[7~' || str === '\x1bOH' ||
          hex === 'e047' || hex === '0047' || hex === '1b5b48'

      // End 键：同上多平台兼容
      const isEnd =
          str === '\x1b[F' || str === '\x1b[4~' || str === '\x1b[8~' || str === '\x1bOF' ||
          hex === 'e04f' || hex === '004f' || hex === '1b5b46'

      // Delete 键（向右删除）：仅匹配 \x1b[3~ 序列，区别于 Backspace 的 \x7f
      const isDelete = str === '\x1b[3~'

      if (isHome) {
        const lastNewline = findLastNewline(val, cur - 1)
        setCursorIndex(lastNewline === -1 ? 0 : lastNewline + 1)
      } else if (isEnd) {
        const nextNewline = findNextNewline(val, cur)
        setCursorIndex(nextNewline === -1 ? val.length : nextNewline)
      } else if (isDelete) {
        // 向右删除（光标位置不变，删除光标右侧字符）
        // 设置 flag 防止 useInput 将这个事件再次当退格处理
        handledByRawRef.current = true
        if (cur < val.length) {
          const newValue = val.slice(0, cur) + val.slice(cur + 1)
          onChange(newValue)
        }
      }
    }

    // prependListener：抢在 Ink 解析器之前拦截数据
    stdin.prependListener('data', onData)
    return () => { stdin.removeListener('data', onData) }
  }, [stdin, onChange])

  /** 用户编辑时：如果正在浏览历史，把当前内容设为新 draft 并回到最新页 */
  function onUserEdit(newValue: string) {
    if (historyIndex !== -1) {
      draftRef.current = newValue
      setHistoryIndex(-1)
    }
  }

  /** 判断光标是否在第一行 */
  function isCursorOnFirstLine(): boolean {
    return value.lastIndexOf('\n', cursorIndex - 1) === -1
  }

  /** 判断光标是否在最后一行 */
  function isCursorOnLastLine(): boolean {
    return value.indexOf('\n', cursorIndex) === -1
  }

  /** 翻阅历史：填入指定 index 的内容 */
  function navigateHistory(newIndex: number) {
    if (newIndex < -1 || newIndex >= history.length) return

    // 首次离开 draft 时保存当前输入
    if (historyIndex === -1) {
      draftRef.current = value
    }

    setHistoryIndex(newIndex)

    let newValue: string
    if (newIndex === -1) {
      // 回到 draft
      newValue = draftRef.current
    } else {
      // 从历史取（history 从旧到新，index=0 对应最新一条）
      newValue = history[history.length - 1 - newIndex]!
    }

    onChange(newValue)
    setCursorIndex(newValue.length)
  }

  function handleSubmit(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    // 提交后重置历史状态
    setHistoryIndex(-1)
    draftRef.current = ''
    if (streaming && onInterruptSubmit) {
      onInterruptSubmit(trimmed)
    } else {
      onSubmit(trimmed)
    }
  }

  // ─── useInput 只需要处理常规的业务按键 ───
  useInput((input, key) => {
    // 拦截残余转义乱码
    if (input && input.includes('\x1b')) return

    if (input === '' && !key.return && !key.escape && !key.backspace && !key.delete
        && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
        && !key.tab && !key.pageUp && !key.pageDown && !key.ctrl && !key.meta) {
      return
    }

    // Submit: Enter
    if (key.return && !key.meta && !key.shift) {
      handleSubmit(value)
      return
    }

    // Newline: Alt+Enter
    if (key.return && key.meta) {
      const newValue = value.slice(0, cursorIndex) + '\n' + value.slice(cursorIndex)
      onUserEdit(newValue)
      onChange(newValue)
      setCursorIndex(cursorIndex + 1)
      return
    }

    if (key.tab || (key.ctrl && input === 'c')) return

    // Ctrl+A / Ctrl+E 依然作为兜底保留
    if (key.ctrl && input === 'a') {
      const lastNewline = findLastNewline(value, cursorIndex - 1)
      setCursorIndex(lastNewline === -1 ? 0 : lastNewline + 1)
      return
    }

    if (key.ctrl && input === 'e') {
      const nextNewline = findNextNewline(value, cursorIndex)
      setCursorIndex(nextNewline === -1 ? value.length : nextNewline)
      return
    }

    // ↑ 上箭头：第一行时翻历史，否则正常上移光标
    if (key.upArrow) {
      if (isCursorOnFirstLine() && history.length > 0) {
        // 翻历史（往旧的方向）
        if (historyIndex < history.length - 1) {
          navigateHistory(historyIndex + 1)
        }
        return
      }
      // 正常多行上移
      const lines = normalizeLineEndings(value).split('\n')
      let currentLineIndex = 0
      let currentPos = 0
      let col = 0
      for (let i = 0; i < lines.length; i++) {
        const lineLen = lines[i]!.length
        const lineEnd = currentPos + lineLen
        if (cursorIndex >= currentPos && cursorIndex <= lineEnd) {
          currentLineIndex = i
          col = cursorIndex - currentPos
          break
        }
        currentPos = lineEnd + 1
      }
      if (currentLineIndex > 0) {
        const targetLine = lines[currentLineIndex - 1]!
        const newCol = Math.min(col, targetLine.length)
        let newIndex = 0
        for (let i = 0; i < currentLineIndex - 1; i++) {
          newIndex += lines[i]!.length + 1
        }
        newIndex += newCol
        setCursorIndex(newIndex)
      }
      return
    }

    // ↓ 下箭头：最后一行时翻历史，否则正常下移光标
    if (key.downArrow) {
      if (isCursorOnLastLine() && historyIndex >= 0) {
        // 翻历史（往新的方向）
        navigateHistory(historyIndex - 1)
        return
      }
      // 正常多行下移
      const lines = normalizeLineEndings(value).split('\n')
      let currentLineIndex = 0
      let currentPos = 0
      let col = 0
      for (let i = 0; i < lines.length; i++) {
        const lineLen = lines[i]!.length
        const lineEnd = currentPos + lineLen
        if (cursorIndex >= currentPos && cursorIndex <= lineEnd) {
          currentLineIndex = i
          col = cursorIndex - currentPos
          break
        }
        currentPos = lineEnd + 1
      }
      if (currentLineIndex < lines.length - 1) {
        const targetLine = lines[currentLineIndex + 1]!
        const newCol = Math.min(col, targetLine.length)
        let newIndex = 0
        for (let i = 0; i < currentLineIndex + 1; i++) {
          newIndex += lines[i]!.length + 1
        }
        newIndex += newCol
        setCursorIndex(newIndex)
      }
      return
    }

    // ← 左箭头
    if (key.leftArrow) {
      setCursorIndex(Math.max(0, cursorIndex - 1))
      return
    }

    // → 右箭头
    if (key.rightArrow) {
      setCursorIndex(Math.min(value.length, cursorIndex + 1))
      return
    }

    // Backspace / Delete 跨平台兼容
    // Ink parse-keypress 的平台差异：
    //   Windows: Backspace → \b(0x08) → key.backspace=true
    //   Linux:   Backspace → \x7f(DEL) → key.delete=true（Ink 已知问题）
    //   Linux:   Delete 键 → \x1b[3~ → key.delete=true
    // 策略：key.backspace 一定是退格；key.delete 中真正的 Delete(\x1b[3~) 由 stdin raw
    // listener 单独处理并设 handledByRawRef，剩余的 key.delete 都是 Linux 下的 Backspace。
    if (key.backspace || key.delete) {
      // 真正的 Delete 键已被 raw listener 处理，跳过
      if (handledByRawRef.current) {
        handledByRawRef.current = false
        return
      }
      // 退格：向左删除
      if (cursorIndex > 0) {
        const newValue = value.slice(0, cursorIndex - 1) + value.slice(cursorIndex)
        onUserEdit(newValue)
        onChange(newValue)
        setCursorIndex(cursorIndex - 1)
      }
      return
    }

    // 普通文本输入
    if (input && !key.ctrl && !key.meta) {
      const newValue = value.slice(0, cursorIndex) + input + value.slice(cursorIndex)
      onUserEdit(newValue)
      onChange(newValue)
      setCursorIndex(cursorIndex + input.length)
    }
  })

  return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{'─'.repeat(columns)}</Text>
        </Box>
        <Box paddingLeft={1}>
          {streaming
              ? <Text dimColor>❯ </Text>
              : <Text color="green">❯ </Text>
          }
          <ControlledMultilineInput
              value={value}
              cursorIndex={cursorIndex}
              placeholder={placeholder}
              rows={1}
              maxRows={10}
          />
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(columns)}</Text>
        </Box>
      </Box>
  )
}
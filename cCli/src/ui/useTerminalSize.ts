// src/ui/useTerminalSize.ts

/**
 * 终端尺寸 Hook — debounce resize 事件，稳定后清屏触发一次干净重绘。
 *
 * 为什么需要 debounce + 清屏：
 * Ink 使用差分渲染（对比上一帧计算需要更新的行），终端宽度突变时
 * 旧帧按旧宽度排列的字符无法被正确覆盖，导致残留乱象。
 * debounce 150ms 后统一清屏 + 更新 state，Ink 在干净画布上重绘一帧。
 */

import { useState, useEffect, useRef } from 'react'
import { useStdout } from 'ink'

/** resize 稳定判定间隔（ms） */
const RESIZE_DEBOUNCE_MS = 150

export function useTerminalSize() {
  const { stdout } = useStdout()
  const [columns, setColumns] = useState(stdout?.columns ?? 80)
  const [rows, setRows] = useState(stdout?.rows ?? 24)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!stdout) return

    const onResize = () => {
      // 清除上一次定时器，实现 debounce
      if (timerRef.current) clearTimeout(timerRef.current)

      timerRef.current = setTimeout(() => {
        timerRef.current = null
        // 清屏：清除可见区域 + scrollback 缓冲区，让下一帧在干净画布上绘制
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
        // 更新 state 触发 React 重渲染
        setColumns(stdout.columns ?? 80)
        setRows(stdout.rows ?? 24)
      }, RESIZE_DEBOUNCE_MS)
    }

    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [stdout])

  return { columns, rows }
}

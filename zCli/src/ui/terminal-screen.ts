// src/ui/terminal-screen.ts

/**
 * 终端备用屏幕缓冲区管理。
 *
 * 进入对话模式时切换到备用屏幕（和 vim/less 相同机制），
 * 退出时还原主屏幕内容。好处：
 * - 对话内容和原终端完全隔离，resize 不会残留旧内容
 * - 退出后终端恢复到进入前的状态
 */

/** 是否已进入备用屏幕 */
let inAlternateScreen = false

/**
 * 进入备用屏幕缓冲区并清屏。
 * 幂等：多次调用只生效一次。
 */
export function enterAlternateScreen(): void {
  if (inAlternateScreen) return
  inAlternateScreen = true
  // \x1b[?1049h — 切换到备用屏幕
  // \x1b[2J      — 清除可见区域
  // \x1b[H       — 光标归位
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H')
}

/**
 * 离开备用屏幕，还原主屏幕内容。
 * 幂等：未进入过备用屏幕时不操作。
 */
export function leaveAlternateScreen(): void {
  if (!inAlternateScreen) return
  inAlternateScreen = false
  process.stdout.write('\x1b[?1049l')
}

/** 查询是否处于备用屏幕中 */
export function isInAlternateScreen(): boolean {
  return inAlternateScreen
}
